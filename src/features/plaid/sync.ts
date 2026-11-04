import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { TokenCryptoError, plaidItemTokenContext } from "@/lib/crypto/tokens";
import {
  PlaidFlowError,
  PlaidProviderError,
  type ProviderAccount,
  type ProviderTransaction,
  type SyncDeps,
  type SyncOptions,
  type SyncPage,
  type SyncSummary,
  type SyncTuning,
  type SyncUpdateStatus,
} from "./types";

/**
 * Manual transaction sync for one connection, shared by the web route and the
 * command-line tool. It is built so that a failure at any point leaves the
 * stored data and the cursor exactly as they were:
 *
 *   1. LEASE      one sync per connection at a time. The lease is a random token
 *                 plus an expiry stored on the Item; a crashed worker's lease
 *                 just expires, and a worker that stalls past its expiry finds
 *                 its token gone when it tries to commit.
 *   2. STAGE      pages are fetched from the saved cursor into memory, outside
 *                 any database transaction (a long transaction would hold locks
 *                 while waiting on the network). The lease is extended on every
 *                 page. Transient errors are retried a bounded number of times;
 *                 "data changed while paging" restarts the WHOLE batch from the
 *                 original cursor; the batch size is bounded.
 *   3. COMMIT     one database transaction that first proves nothing changed
 *                 (the lease token is still ours and the cursor and its version
 *                 are what we started from), then applies the changes and moves
 *                 the cursor. If anything fails, all of it rolls back.
 *
 * Plaid answers "no data yet" with empty results and an EMPTY cursor; that is a
 * success with nothing to show, and the empty cursor is never saved.
 */

const DEFAULT_TUNING: SyncTuning = {
  pageSize: 200,
  // 100 pages of 200 = 20,000 updates held in memory and applied in one
  // transaction. Beyond that a sync is refused rather than risking the database.
  maxPages: 100,
  maxRestarts: 3,
  maxAttempts: 3,
  leaseMs: 5 * 60_000,
  backoffMs: (attempt) => Math.min(500 * 2 ** (attempt - 1), 4000),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Minimum gap between manual syncs from the web UI. The command line is not limited. */
export const MANUAL_SYNC_MIN_INTERVAL_MS = 60_000;

const COMMIT_TIMEOUT_MS = 120_000;
const WRITE_CHUNK = 1000;

const TRANSIENT = new Set(["timeout", "unavailable", "rate_limited"]);

/** A reason this run stopped, as a safe code. */
class SyncAbort extends Error {
  constructor(readonly code: string) {
    super(`Sync aborted (${code})`);
    this.name = "SyncAbort";
  }
}

type Staged = {
  added: Map<string, ProviderTransaction>;
  modified: Map<string, ProviderTransaction>;
  removed: Map<string, string>;
  accounts: Map<string, ProviderAccount>;
  nextCursor: string;
  status: SyncUpdateStatus;
  pages: number;
  requestId: string | null;
};

function emptyStage(): Staged {
  return {
    added: new Map(),
    modified: new Map(),
    removed: new Map(),
    accounts: new Map(),
    nextCursor: "",
    status: "UNKNOWN",
    pages: 0,
    requestId: null,
  };
}

/** Fold one page into the staged batch; later pages win, and a removal beats an earlier add or change. */
function stagePage(staged: Staged, page: SyncPage): void {
  for (const t of page.added) {
    staged.removed.delete(t.providerTransactionId);
    staged.added.set(t.providerTransactionId, t);
  }
  for (const t of page.modified) {
    staged.removed.delete(t.providerTransactionId);
    // Changed after being added in this same batch: still one new row.
    if (staged.added.has(t.providerTransactionId)) staged.added.set(t.providerTransactionId, t);
    else staged.modified.set(t.providerTransactionId, t);
  }
  for (const r of page.removed) {
    staged.added.delete(r.providerTransactionId);
    staged.modified.delete(r.providerTransactionId);
    staged.removed.set(r.providerTransactionId, r.externalAccountId);
  }
  for (const a of page.accounts) staged.accounts.set(a.externalAccountId, a);
  staged.status = page.status;
  staged.requestId = page.requestId ?? staged.requestId;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function syncItem(
  deps: SyncDeps,
  householdId: string,
  connectionId: string,
  options: SyncOptions = {},
): Promise<SyncSummary> {
  const { db, plaid, tokens, environment } = deps;
  const tuning: SyncTuning = { ...DEFAULT_TUNING, ...deps.sync };
  const now = () => (deps.now ?? (() => new Date()))();

  // ---- Preconditions (nothing is written if these fail) --------------------
  const item = await db.plaidItem.findFirst({ where: { id: connectionId, householdId, environment } });
  if (!item || !item.accessTokenCiphertext || item.status === "DISCONNECTED") {
    throw new PlaidFlowError("connection_not_found");
  }
  if (item.status === "LOGIN_REQUIRED") throw new PlaidFlowError("reconnect_required");

  let accessToken: string;
  try {
    accessToken = tokens.decrypt(item.accessTokenCiphertext, plaidItemTokenContext(item.environment, item.plaidItemId));
  } catch (error) {
    if (error instanceof TokenCryptoError) throw new PlaidFlowError("token_unreadable");
    throw error;
  }

  const startedAt = now();
  if (options.minIntervalMs) {
    const last = await db.syncRun.findFirst({
      where: { plaidItemId: item.id },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });
    if (last) {
      const elapsed = startedAt.getTime() - last.startedAt.getTime();
      if (elapsed < options.minIntervalMs) {
        const retryAfterSeconds = Math.ceil((options.minIntervalMs - elapsed) / 1000);
        throw new PlaidFlowError("sync_throttled", undefined, { retryAfterSeconds });
      }
    }
  }

  // ---- 1. Lease ------------------------------------------------------------
  const leaseToken = randomUUID();
  const acquired = await db.plaidItem.updateMany({
    where: { id: item.id, OR: [{ syncLeaseExpiresAt: null }, { syncLeaseExpiresAt: { lte: startedAt } }] },
    data: { syncLeaseToken: leaseToken, syncLeaseExpiresAt: new Date(startedAt.getTime() + tuning.leaseMs) },
  });
  if (acquired.count !== 1) throw new PlaidFlowError("sync_in_progress");

  // Read the cursor only now that the lease is ours: another sync may have
  // committed between our first read and acquiring the lease.
  const start = await db.plaidItem.findUniqueOrThrow({
    where: { id: item.id },
    select: { syncCursor: true, syncCursorVersion: true },
  });
  const run = await db.syncRun.create({ data: { plaidItemId: item.id, startedAt }, select: { id: true } });

  const heartbeat = async () => {
    const extended = await db.plaidItem.updateMany({
      where: { id: item.id, syncLeaseToken: leaseToken },
      data: { syncLeaseExpiresAt: new Date(now().getTime() + tuning.leaseMs) },
    });
    if (extended.count !== 1) throw new SyncAbort("lease_lost");
  };

  // ---- 2. Stage ------------------------------------------------------------
  async function fetchPage(cursor: string | null): Promise<SyncPage> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await plaid.syncTransactions(accessToken, cursor, tuning.pageSize);
      } catch (error) {
        if (!(error instanceof PlaidProviderError)) throw error;
        if (!TRANSIENT.has(error.kind) || attempt >= tuning.maxAttempts) throw error;
        await tuning.sleep(tuning.backoffMs(attempt));
      }
    }
  }

  async function stageOnce(): Promise<Staged> {
    const staged = emptyStage();
    let cursor = start.syncCursor;
    for (;;) {
      if (staged.pages >= tuning.maxPages) throw new SyncAbort("sync_too_large");
      await heartbeat();
      const page = await fetchPage(cursor);
      staged.pages += 1;
      stagePage(staged, page);
      if (!page.hasMore) {
        staged.nextCursor = page.nextCursor;
        return staged;
      }
      if (!page.nextCursor) throw new SyncAbort("unexpected_response");
      cursor = page.nextCursor;
    }
  }

  async function stage(): Promise<Staged> {
    for (let round = 0; ; round++) {
      try {
        return await stageOnce();
      } catch (error) {
        const mutated = error instanceof PlaidProviderError && error.kind === "mutation_during_pagination";
        if (!mutated || round >= tuning.maxRestarts) throw error;
        // Do not patch up the half-read batch: drop it and read it all again
        // from the cursor this sync began with.
        await tuning.sleep(tuning.backoffMs(round + 1));
      }
    }
  }

  // ---- Outcomes ------------------------------------------------------------
  const succeeded = (staged: Staged, completedAt: Date): SyncSummary => ({
    runId: run.id,
    status: "SUCCEEDED",
    added: staged.added.size,
    modified: staged.modified.size,
    removed: staged.removed.size,
    completedAt,
    errorCode: null,
    providerStatus: staged.status,
  });

  const failed = async (code: string, loginRequired = false): Promise<SyncSummary> => {
    const completedAt = now();
    // Only touch the Item while the lease is still ours; a worker that lost it
    // must not overwrite the state of whoever took over.
    await db.plaidItem
      .updateMany({
        where: { id: item.id, syncLeaseToken: leaseToken },
        data: {
          lastErrorCode: code,
          lastErrorAt: completedAt,
          ...(loginRequired ? { status: "LOGIN_REQUIRED" as const } : {}),
          syncLeaseToken: null,
          syncLeaseExpiresAt: null,
        },
      })
      .catch(() => undefined);
    await db.syncRun
      .update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: completedAt, errorCode: code } })
      .catch(() => undefined);
    return {
      runId: run.id,
      status: "FAILED",
      added: 0,
      modified: 0,
      removed: 0,
      completedAt,
      errorCode: code,
      providerStatus: null,
    };
  };

  try {
    const staged = await stage();

    // Plaid has nothing yet: empty results and an empty cursor. A success, but
    // there is no cursor to save and no data to apply.
    if (staged.nextCursor === "") {
      if (staged.added.size + staged.modified.size + staged.removed.size > 0) throw new SyncAbort("unexpected_response");
      const completedAt = now();
      await db.plaidItem.updateMany({
        where: { id: item.id, syncLeaseToken: leaseToken },
        data: { lastErrorCode: null, lastErrorAt: null, syncLeaseToken: null, syncLeaseExpiresAt: null },
      });
      await db.syncRun.update({
        where: { id: run.id },
        data: runDone(staged, completedAt),
      });
      return succeeded(staged, completedAt);
    }

    // ---- 3. Commit ---------------------------------------------------------
    const completedAt = now();
    try {
      await db.$transaction(
        async (tx) => {
          // Prove nothing moved while we were reading. This single guarded
          // UPDATE also takes the row lock, so it cannot race another commit.
          const guard = await tx.plaidItem.updateMany({
            where: {
              id: item.id,
              syncLeaseToken: leaseToken,
              syncCursor: start.syncCursor,
              syncCursorVersion: start.syncCursorVersion,
            },
            data: {
              syncCursor: staged.nextCursor,
              syncCursorVersion: { increment: 1 },
              lastSuccessfulSyncAt: completedAt,
              lastErrorCode: null,
              lastErrorAt: null,
              syncLeaseToken: null,
              syncLeaseExpiresAt: null,
            },
          });
          if (guard.count !== 1) {
            const current = await tx.plaidItem.findUnique({ where: { id: item.id }, select: { syncLeaseToken: true } });
            throw new SyncAbort(current?.syncLeaseToken === leaseToken ? "cursor_conflict" : "lease_lost");
          }

          await applyBatch(tx, { itemId: item.id, householdId, staged, now: completedAt });
          await tx.syncRun.update({ where: { id: run.id }, data: runDone(staged, completedAt) });
        },
        { timeout: COMMIT_TIMEOUT_MS, maxWait: 10_000 },
      );
    } catch (error) {
      if (error instanceof SyncAbort) throw error;
      throw new SyncAbort("persistence_failed");
    }
    return succeeded(staged, completedAt);
  } catch (error) {
    if (error instanceof SyncAbort) return failed(error.code);
    if (error instanceof PlaidProviderError) return failed(error.code ?? error.kind, error.kind === "login_required");
    console.error("[plaid] sync failed unexpectedly", { name: error instanceof Error ? error.name : typeof error });
    return failed("unexpected_error");
  }
}

function runDone(staged: Staged, completedAt: Date) {
  return {
    status: "SUCCEEDED" as const,
    finishedAt: completedAt,
    addedCount: staged.added.size,
    modifiedCount: staged.modified.size,
    removedCount: staged.removed.size,
    pageCount: staged.pages,
    providerStatus: staged.status,
    plaidRequestId: staged.requestId,
  };
}

/** Writes a staged batch. Runs inside the commit transaction: any throw undoes all of it. */
async function applyBatch(
  tx: Prisma.TransactionClient,
  input: { itemId: string; householdId: string; staged: Staged; now: Date },
): Promise<void> {
  const { itemId, householdId, staged, now } = input;

  // Accounts: the ones we know, plus any Plaid described for the first time.
  const known = new Map(
    (await tx.account.findMany({ where: { plaidItemId: itemId }, select: { id: true, externalAccountId: true } })).map(
      (a) => [a.externalAccountId, a.id] as const,
    ),
  );
  for (const described of staged.accounts.values()) {
    if (known.has(described.externalAccountId)) continue;
    const created = await tx.account.create({
      data: {
        householdId,
        plaidItemId: itemId,
        externalAccountId: described.externalAccountId,
        name: described.name,
        officialName: described.officialName,
        mask: described.mask,
        type: described.type,
        subtype: described.subtype,
        currency: described.currency,
      },
      select: { id: true },
    });
    known.set(described.externalAccountId, created.id);
  }

  // Removals first, so a transaction removed and then re-added stays live.
  for (const ids of chunks([...staged.removed.keys()], WRITE_CHUNK)) {
    await tx.transaction.updateMany({
      where: { plaidItemId: itemId, providerTransactionId: { in: ids }, removedAt: null },
      data: { removedAt: now },
    });
  }

  // Added and modified are the same operation: idempotent upserts, so applying
  // a batch twice changes nothing the second time.
  const changes = [...staged.added.values(), ...staged.modified.values()];
  for (const t of changes) {
    const accountId = known.get(t.externalAccountId);
    if (!accountId) throw new SyncAbort("unknown_account");
    const fields = {
      accountId,
      amount: new Prisma.Decimal(t.amount),
      currency: t.currency,
      date: new Date(`${t.date}T00:00:00.000Z`),
      authorizedDate: t.authorizedDate ? new Date(`${t.authorizedDate}T00:00:00.000Z`) : null,
      pending: t.pending,
      pendingProviderTransactionId: t.pendingProviderTransactionId,
      description: t.description,
      merchantName: t.merchantName,
    };
    await tx.transaction.upsert({
      where: { plaidItemId_providerTransactionId: { plaidItemId: itemId, providerTransactionId: t.providerTransactionId } },
      create: { plaidItemId: itemId, providerTransactionId: t.providerTransactionId, ...fields },
      update: { ...fields, removedAt: null },
    });
  }

  // A posted transaction replaces its pending twin. Plaid usually also lists the
  // pending id as removed, but not always in the same batch; retire the twin
  // here so the charge is never counted twice.
  const superseded = changes
    .filter((t) => !t.pending && t.pendingProviderTransactionId)
    .map((t) => t.pendingProviderTransactionId as string);
  for (const ids of chunks(superseded, WRITE_CHUNK)) {
    await tx.transaction.updateMany({
      where: { plaidItemId: itemId, providerTransactionId: { in: ids }, pending: true, removedAt: null },
      data: { removedAt: now },
    });
  }
}
