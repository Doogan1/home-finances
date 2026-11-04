import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { syncItem } from "@/features/plaid/sync";
import type { SyncDeps } from "@/features/plaid/types";
import { createTokenCipher } from "@/lib/crypto/tokens";
import {
  ACCESS_TOKEN,
  MUTATION_ERROR,
  SECRET_IN_SDK_ERRORS,
  account,
  createFakePlaidApi,
  networkError,
  sdkError,
  syncPage,
  txn,
} from "./helpers/fake-plaid";
import { makeDeps, seedConnection, seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

// Manual transaction sync against the throwaway database with a fake Plaid SDK.
// Time is controlled (`clock`) and waiting is a no-op, so retries and lease
// expiry are exercised instantly and deterministically.

const { ownerUrl, appUrl } = inject("testDatabase");
const CHECKING = "item_synthetic_1_checking";
const SAVINGS = "item_synthetic_1_savings";
const LEASE_MS = 5 * 60_000;

let owner: PrismaClient;
let app: PrismaClient;
let api: ReturnType<typeof createFakePlaidApi>;
let clock: Date;
let sleeps: number[];

beforeAll(() => {
  owner = createTestClient(ownerUrl);
  app = createTestClient(appUrl);
});
afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});
beforeEach(async () => {
  await truncateAll(owner);
  api = createFakePlaidApi();
  clock = new Date("2026-11-03T12:00:00Z");
  sleeps = [];
});

function deps(overrides: Partial<SyncDeps["sync"]> = {}, db: PrismaClient = app, extra: Partial<SyncDeps> = {}): SyncDeps {
  return {
    ...makeDeps(db, api, { now: () => clock }),
    ...extra,
    sync: {
      pageSize: 100,
      maxPages: 50,
      maxRestarts: 2,
      maxAttempts: 3,
      leaseMs: LEASE_MS,
      backoffMs: (attempt) => attempt * 1000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...overrides,
    },
  };
}

async function setup(status: "ACTIVE" | "PENDING" | "LOGIN_REQUIRED" = "ACTIVE") {
  const person = await seedPerson(owner, "a@example.test");
  const item = await seedConnection(owner, person.householdId, { status });
  return { ...person, item };
}

const stored = () => owner.transaction.findMany({ orderBy: { providerTransactionId: "asc" } });
const itemRow = (id: string) => owner.plaidItem.findUniqueOrThrow({ where: { id } });
const requestCursors = () => api.transactionsSync.mock.calls.map((c) => (c[0] as { cursor?: string }).cursor);

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("a first sync", () => {
  it("treats 'not ready yet' as success with nothing to show, and keeps no cursor", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync.mockResolvedValueOnce(syncPage({ next_cursor: "", status: "NOT_READY" }));

    const summary = await syncItem(deps(), householdId, item.id);

    expect(summary).toMatchObject({ status: "SUCCEEDED", added: 0, modified: 0, removed: 0, providerStatus: "NOT_READY", errorCode: null });
    const row = await itemRow(item.id);
    expect(row.syncCursor).toBeNull(); // Plaid's empty cursor must never be saved as "synced"
    expect(row.lastSuccessfulSyncAt).toBeNull();
    expect(row.syncLeaseToken).toBeNull();
    expect(await stored()).toHaveLength(0);

    // Next time it starts from the beginning again, still without a cursor.
    api.transactionsSync.mockResolvedValueOnce(syncPage({ added: [txn({ transaction_id: "t1", account_id: CHECKING })], next_cursor: "c1" }));
    await syncItem(deps(), householdId, item.id);
    expect(requestCursors()).toEqual([undefined, undefined]);
    expect((await itemRow(item.id)).syncCursor).toBe("c1");
  });

  it("applies several pages in order, and only then moves the cursor", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync
      .mockResolvedValueOnce(syncPage({ added: [txn({ transaction_id: "t1", account_id: CHECKING })], next_cursor: "c1", has_more: true }))
      .mockResolvedValueOnce(syncPage({ added: [txn({ transaction_id: "t2", account_id: CHECKING })], next_cursor: "c2", has_more: true }))
      .mockResolvedValueOnce(
        syncPage({ added: [txn({ transaction_id: "t3", account_id: SAVINGS })], modified: [], next_cursor: "c3", has_more: false }),
      );

    const summary = await syncItem(deps({ pageSize: 2 }), householdId, item.id);

    expect(summary).toMatchObject({ status: "SUCCEEDED", added: 3, modified: 0, removed: 0 });
    expect(requestCursors()).toEqual([undefined, "c1", "c2"]);
    expect(api.transactionsSync.mock.calls[0][0]).toMatchObject({ access_token: ACCESS_TOKEN, count: 2 });
    expect((await stored()).map((t) => t.providerTransactionId)).toEqual(["t1", "t2", "t3"]);
    const row = await itemRow(item.id);
    expect(row).toMatchObject({ syncCursor: "c3", syncCursorVersion: 1, syncLeaseToken: null, lastErrorCode: null });
    expect(row.lastSuccessfulSyncAt).toEqual(clock);
    const run = await owner.syncRun.findUniqueOrThrow({ where: { id: summary.runId } });
    expect(run).toMatchObject({ status: "SUCCEEDED", pageCount: 3, addedCount: 3, providerStatus: "HISTORICAL_UPDATE_COMPLETE" });
  });
});

describe("added, modified and removed", () => {
  it("keeps Plaid's sign and exact decimals, then applies changes and removals later", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({
        added: [
          txn({ transaction_id: "spend", account_id: CHECKING, amount: 12.3 }),
          txn({ transaction_id: "refund", account_id: CHECKING, amount: -45.67, name: "Refund" }),
          txn({ transaction_id: "gone", account_id: SAVINGS, amount: 0.1 }),
        ],
        next_cursor: "c1",
      }),
    );
    await syncItem(deps(), householdId, item.id);
    const first = Object.fromEntries((await stored()).map((t) => [t.providerTransactionId, t]));
    expect(first.spend.amount.toFixed()).toBe("12.3");
    expect(first.refund.amount.toFixed()).toBe("-45.67"); // negative = money in, kept as received
    expect(first.spend).toMatchObject({ currency: "USD", pending: false, description: "Coffee shop", merchantName: "Coffee Shop" });

    clock = new Date("2026-11-04T12:00:00Z");
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({
        modified: [txn({ transaction_id: "spend", account_id: CHECKING, amount: 13.5, name: "Coffee shop (final)" })],
        removed: [{ transaction_id: "gone", account_id: SAVINGS }],
        next_cursor: "c2",
      }),
    );
    const summary = await syncItem(deps(), householdId, item.id);

    expect(summary).toMatchObject({ status: "SUCCEEDED", added: 0, modified: 1, removed: 1 });
    expect(requestCursors()).toEqual([undefined, "c1"]);
    const second = Object.fromEntries((await stored()).map((t) => [t.providerTransactionId, t]));
    expect(second.spend.amount.toFixed()).toBe("13.5");
    expect(second.spend.description).toBe("Coffee shop (final)");
    expect(second.gone.removedAt).toEqual(clock); // kept as a record, excluded from live data
    expect(second.refund.removedAt).toBeNull();
  });

  it("a repeated sync with nothing new is harmless", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({ added: [txn({ transaction_id: "t1", account_id: CHECKING })], next_cursor: "c1" }),
    );
    await syncItem(deps(), householdId, item.id);
    const before = await stored();
    api.transactionsSync.mockResolvedValueOnce(syncPage({ next_cursor: "c1" }));

    const summary = await syncItem(deps(), householdId, item.id);

    expect(summary).toMatchObject({ status: "SUCCEEDED", added: 0, modified: 0, removed: 0 });
    expect(await stored()).toEqual(before);
    expect(await owner.syncRun.count()).toBe(2);
  });

  it("re-applying a batch it has already seen creates no duplicates", async () => {
    const { householdId, item } = await setup();
    const batch = () => syncPage({ added: [txn({ transaction_id: "t1", account_id: CHECKING })], next_cursor: "c1" });
    api.transactionsSync.mockResolvedValueOnce(batch());
    await syncItem(deps(), householdId, item.id);
    await owner.plaidItem.update({ where: { id: item.id }, data: { syncCursor: null } }); // as if the cursor were lost
    api.transactionsSync.mockResolvedValueOnce(batch());

    await syncItem(deps(), householdId, item.id);

    expect(await stored()).toHaveLength(1);
  });
});

describe("pending and posted transactions", () => {
  it("never counts a pending charge and the posted one that replaced it", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({ added: [txn({ transaction_id: "pending_1", account_id: CHECKING, pending: true, amount: 20 })], next_cursor: "c1" }),
    );
    await syncItem(deps(), householdId, item.id);

    // Plaid reports the posted version; the pending id is NOT in `removed` this time.
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({
        added: [txn({ transaction_id: "posted_1", account_id: CHECKING, amount: 20, pending_transaction_id: "pending_1" })],
        next_cursor: "c2",
      }),
    );
    await syncItem(deps(), householdId, item.id);

    const live = (await stored()).filter((t) => t.removedAt === null);
    expect(live.map((t) => t.providerTransactionId)).toEqual(["posted_1"]);
    expect(live[0]).toMatchObject({ pending: false, pendingProviderTransactionId: "pending_1" });
    expect((await stored()).find((t) => t.providerTransactionId === "pending_1")?.removedAt).not.toBeNull();
  });

  it("handles the pending id arriving in `removed` as well", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({ added: [txn({ transaction_id: "pending_1", account_id: CHECKING, pending: true })], next_cursor: "c1" }),
    );
    await syncItem(deps(), householdId, item.id);
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({
        added: [txn({ transaction_id: "posted_1", account_id: CHECKING, pending_transaction_id: "pending_1" })],
        removed: [{ transaction_id: "pending_1", account_id: CHECKING }],
        next_cursor: "c2",
      }),
    );

    const summary = await syncItem(deps(), householdId, item.id);

    expect(summary.removed).toBe(1);
    expect((await stored()).filter((t) => t.removedAt === null).map((t) => t.providerTransactionId)).toEqual(["posted_1"]);
  });
});

describe("failures never move the cursor", () => {
  it("leaves nothing behind when a later page fails for good", async () => {
    const { householdId, item } = await setup();
    await owner.plaidItem.update({ where: { id: item.id }, data: { syncCursor: "start" } });
    api.transactionsSync
      .mockResolvedValueOnce(syncPage({ added: [txn({ transaction_id: "t1", account_id: CHECKING })], next_cursor: "c1", has_more: true }))
      .mockRejectedValue(networkError("ECONNABORTED"));

    const summary = await syncItem(deps(), householdId, item.id);

    expect(summary).toMatchObject({ status: "FAILED", errorCode: "timeout", added: 0 });
    expect(await stored()).toHaveLength(0); // page 1 was staged, never applied
    const row = await itemRow(item.id);
    expect(row).toMatchObject({ syncCursor: "start", syncCursorVersion: 0, syncLeaseToken: null, lastErrorCode: "timeout" });
    expect(await owner.syncRun.findUniqueOrThrow({ where: { id: summary.runId } })).toMatchObject({
      status: "FAILED",
      errorCode: "timeout",
    });
    expect(api.transactionsSync).toHaveBeenCalledTimes(1 + 3); // page 1, then 3 attempts at page 2
    expect(sleeps).toEqual([1000, 2000]); // bounded backoff between attempts
  });

  it("retries a transient error on a page and then succeeds", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync
      .mockResolvedValueOnce(syncPage({ added: [txn({ transaction_id: "t1", account_id: CHECKING })], next_cursor: "c1", has_more: true }))
      .mockRejectedValueOnce(sdkError(500, { error_type: "API_ERROR", error_code: "INTERNAL_SERVER_ERROR" }))
      .mockResolvedValueOnce(syncPage({ added: [txn({ transaction_id: "t2", account_id: CHECKING })], next_cursor: "c2" }));

    const summary = await syncItem(deps(), householdId, item.id);

    expect(summary).toMatchObject({ status: "SUCCEEDED", added: 2 });
    expect(requestCursors()).toEqual([undefined, "c1", "c1"]);
    expect(sleeps).toEqual([1000]);
  });

  it("does not retry an error that retrying cannot fix", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync.mockRejectedValue(sdkError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS" }));

    const summary = await syncItem(deps(), householdId, item.id);

    expect(summary).toMatchObject({ status: "FAILED", errorCode: "INVALID_API_KEYS" });
    expect(api.transactionsSync).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("flags the connection when the bank wants a new sign-in, without retrying", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync.mockRejectedValue(sdkError(400, { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED" }));

    const summary = await syncItem(deps(), householdId, item.id);

    expect(summary).toMatchObject({ status: "FAILED", errorCode: "ITEM_LOGIN_REQUIRED" });
    expect(api.transactionsSync).toHaveBeenCalledTimes(1);
    expect(await itemRow(item.id)).toMatchObject({ status: "LOGIN_REQUIRED", lastErrorCode: "ITEM_LOGIN_REQUIRED", syncCursor: null });
  });

  it("never leaks SDK error contents into the summary or the stored run", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync.mockRejectedValue(sdkError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS" }));

    const summary = await syncItem(deps(), householdId, item.id);

    const everything = JSON.stringify([summary, await owner.syncRun.findMany(), await itemRow(item.id)]);
    expect(everything).not.toContain(SECRET_IN_SDK_ERRORS);
    expect(everything).not.toContain(ACCESS_TOKEN);
  });

  it("refuses an oversized sync instead of holding unbounded data", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync.mockImplementation(async () =>
      syncPage({ added: [txn({ transaction_id: `t${api.transactionsSync.mock.calls.length}`, account_id: CHECKING })], next_cursor: "c", has_more: true }),
    );

    const summary = await syncItem(deps({ maxPages: 3 }), householdId, item.id);

    expect(summary).toMatchObject({ status: "FAILED", errorCode: "sync_too_large" });
    expect(api.transactionsSync).toHaveBeenCalledTimes(3);
    expect(await stored()).toHaveLength(0);
    expect((await itemRow(item.id)).syncCursor).toBeNull();
  });
});

describe("mutation during pagination", () => {
  it("restarts the whole batch from the ORIGINAL cursor and discards what it staged", async () => {
    const { householdId, item } = await setup();
    await owner.plaidItem.update({ where: { id: item.id }, data: { syncCursor: "start" } });
    api.transactionsSync
      .mockResolvedValueOnce(syncPage({ added: [txn({ transaction_id: "only_in_aborted_round", account_id: CHECKING })], next_cursor: "c1", has_more: true }))
      .mockRejectedValueOnce(sdkError(400, MUTATION_ERROR))
      .mockResolvedValueOnce(syncPage({ added: [txn({ transaction_id: "t1", account_id: CHECKING })], next_cursor: "c9", has_more: true }))
      .mockResolvedValueOnce(syncPage({ added: [txn({ transaction_id: "t2", account_id: CHECKING })], next_cursor: "c10" }));

    const summary = await syncItem(deps(), householdId, item.id);

    expect(summary).toMatchObject({ status: "SUCCEEDED", added: 2 });
    // Round 1: start -> c1 (mutation). Round 2 begins again at "start", not at c1.
    expect(requestCursors()).toEqual(["start", "c1", "start", "c9"]);
    expect((await stored()).map((t) => t.providerTransactionId)).toEqual(["t1", "t2"]);
    expect((await itemRow(item.id)).syncCursor).toBe("c10");
  });

  it("gives up after a bounded number of restarts, leaving everything as it was", async () => {
    const { householdId, item } = await setup();
    await owner.plaidItem.update({ where: { id: item.id }, data: { syncCursor: "start" } });
    api.transactionsSync.mockImplementation(async () => {
      if (api.transactionsSync.mock.calls.length % 2 === 0) throw sdkError(400, MUTATION_ERROR);
      return syncPage({ added: [txn({ transaction_id: "t", account_id: CHECKING })], next_cursor: "c1", has_more: true });
    });

    const summary = await syncItem(deps({ maxRestarts: 2 }), householdId, item.id);

    expect(summary).toMatchObject({ status: "FAILED", errorCode: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" });
    expect(requestCursors().filter((c) => c === "start")).toHaveLength(3); // first round + 2 restarts
    expect(await stored()).toHaveLength(0);
    expect((await itemRow(item.id)).syncCursor).toBe("start");
  });
});

describe("accounts that appear in a sync", () => {
  it("creates an account Plaid reports for the first time, then stores its transactions", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({
        accounts: [account({ account_id: "acct_new", name: "Brand New", mask: "7777" })],
        added: [txn({ transaction_id: "t1", account_id: "acct_new" })],
        next_cursor: "c1",
      }),
    );

    await syncItem(deps(), householdId, item.id);

    const created = await owner.account.findFirstOrThrow({ where: { externalAccountId: "acct_new" } });
    expect(created).toMatchObject({ name: "Brand New", mask: "7777", householdId, plaidItemId: item.id, active: true });
    expect((await stored())[0].accountId).toBe(created.id);
  });

  it("rolls everything back if a transaction belongs to an account nobody has described", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({
        added: [txn({ transaction_id: "t1", account_id: CHECKING }), txn({ transaction_id: "t2", account_id: "acct_mystery" })],
        next_cursor: "c1",
      }),
    );

    const summary = await syncItem(deps(), householdId, item.id);

    expect(summary).toMatchObject({ status: "FAILED", errorCode: "unknown_account" });
    expect(await stored()).toHaveLength(0); // t1 was valid but must not survive
    expect((await itemRow(item.id)).syncCursor).toBeNull();
  });
});

describe("database failure during the commit", () => {
  it("rolls back every row and the cursor, and releases the lease", async () => {
    const { householdId, item } = await setup();
    // A database whose third transaction upsert fails, as if PostgreSQL dropped
    // the connection part-way through applying the batch.
    const failing = new Proxy(app, {
      get(target, prop) {
        if (prop === "$transaction") {
          return (fn: (tx: PrismaClient) => Promise<unknown>) =>
            target.$transaction(async (tx) => {
              let upserts = 0;
              const wrapped = new Proxy(tx, {
                get(txTarget, txProp) {
                  if (txProp === "transaction") {
                    return new Proxy(txTarget.transaction, {
                      get(model, method) {
                        if (method === "upsert") {
                          return (args: never) => {
                            if (++upserts === 3) return Promise.reject(new Error("simulated connection loss"));
                            return model.upsert(args);
                          };
                        }
                        return Reflect.get(model, method, model);
                      },
                    });
                  }
                  return Reflect.get(txTarget, txProp, txTarget);
                },
              });
              return fn(wrapped as unknown as PrismaClient);
            });
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PrismaClient;
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({
        added: ["a", "b", "c", "d"].map((id) => txn({ transaction_id: id, account_id: CHECKING })),
        next_cursor: "c1",
      }),
    );

    const summary = await syncItem(deps({}, failing), householdId, item.id);

    expect(summary).toMatchObject({ status: "FAILED", errorCode: "persistence_failed" });
    expect(await stored()).toHaveLength(0);
    expect(await itemRow(item.id)).toMatchObject({ syncCursor: null, syncCursorVersion: 0, syncLeaseToken: null });
    expect(await owner.syncRun.findUniqueOrThrow({ where: { id: summary.runId } })).toMatchObject({
      status: "FAILED",
      errorCode: "persistence_failed",
      addedCount: 0,
    });
  });
});

describe("one sync at a time", () => {
  it("rejects a second sync while the first holds the lease, without creating a run or calling Plaid", async () => {
    const { householdId, item } = await setup();
    const entered = deferred();
    const release = deferred();
    api.transactionsSync.mockImplementationOnce(async () => {
      entered.release();
      await release.promise;
      return syncPage({ added: [txn({ transaction_id: "t1", account_id: CHECKING })], next_cursor: "c1" });
    });

    const first = syncItem(deps(), householdId, item.id);
    await entered.promise;
    const second = syncItem(deps(), householdId, item.id);

    await expect(second).rejects.toMatchObject({ code: "sync_in_progress" });
    expect(api.transactionsSync).toHaveBeenCalledTimes(1);
    expect(await owner.syncRun.count()).toBe(1);

    release.release();
    expect(await first).toMatchObject({ status: "SUCCEEDED", added: 1 });
    expect((await itemRow(item.id)).syncLeaseToken).toBeNull();
  });

  it("lets a new sync take over from a worker that crashed (its lease expired)", async () => {
    const { householdId, item } = await setup();
    await owner.plaidItem.update({
      where: { id: item.id },
      data: { syncLeaseToken: "dead-worker", syncLeaseExpiresAt: new Date(clock.getTime() - 1000) },
    });
    api.transactionsSync.mockResolvedValueOnce(syncPage({ added: [txn({ transaction_id: "t1", account_id: CHECKING })], next_cursor: "c1" }));

    const summary = await syncItem(deps(), householdId, item.id);

    expect(summary.status).toBe("SUCCEEDED");
    expect((await itemRow(item.id)).syncLeaseToken).toBeNull();
  });

  it("still refuses while a lease is unexpired", async () => {
    const { householdId, item } = await setup();
    await owner.plaidItem.update({
      where: { id: item.id },
      data: { syncLeaseToken: "other-worker", syncLeaseExpiresAt: new Date(clock.getTime() + 60_000) },
    });

    await expect(syncItem(deps(), householdId, item.id)).rejects.toMatchObject({ code: "sync_in_progress" });
    expect((await itemRow(item.id)).syncLeaseToken).toBe("other-worker"); // not stolen
  });

  it("rejects the commit of a stale lease holder whose lease expired and was taken over", async () => {
    const { householdId, item } = await setup();
    const entered = deferred();
    const release = deferred();
    api.transactionsSync.mockImplementationOnce(async () => {
      entered.release();
      await release.promise;
      return syncPage({ added: [txn({ transaction_id: "from_stale_worker", account_id: CHECKING })], next_cursor: "stale_cursor" });
    });

    const stale = syncItem(deps(), householdId, item.id);
    await entered.promise;
    // The stale worker stalls past its lease; another sync takes over and finishes.
    clock = new Date(clock.getTime() + LEASE_MS + 1000);
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({ added: [txn({ transaction_id: "from_new_worker", account_id: CHECKING })], next_cursor: "good_cursor" }),
    );
    const takeover = await syncItem(deps(), householdId, item.id);
    expect(takeover.status).toBe("SUCCEEDED");

    release.release();
    const staleSummary = await stale;

    expect(staleSummary).toMatchObject({ status: "FAILED", errorCode: "lease_lost" });
    expect((await stored()).map((t) => t.providerTransactionId)).toEqual(["from_new_worker"]);
    expect(await itemRow(item.id)).toMatchObject({ syncCursor: "good_cursor", syncCursorVersion: 1, syncLeaseToken: null });
  });

  it("makes the stale worker lose even while the new lease-holder is still mid-sync", async () => {
    const { householdId, item } = await setup();
    const staleEntered = deferred();
    const staleRelease = deferred();
    const currentEntered = deferred();
    const currentRelease = deferred();
    api.transactionsSync
      .mockImplementationOnce(async () => {
        staleEntered.release();
        await staleRelease.promise;
        return syncPage({ added: [txn({ transaction_id: "from_stale_worker", account_id: CHECKING })], next_cursor: "stale_cursor" });
      })
      .mockImplementationOnce(async () => {
        currentEntered.release();
        await currentRelease.promise;
        return syncPage({ added: [txn({ transaction_id: "from_current_worker", account_id: CHECKING })], next_cursor: "good_cursor" });
      });

    const stale = syncItem(deps(), householdId, item.id);
    await staleEntered.promise;
    clock = new Date(clock.getTime() + LEASE_MS + 1000); // the stale worker's lease runs out
    const current = syncItem(deps(), householdId, item.id); // ...and a new sync takes over
    await currentEntered.promise;

    // The stale worker finishes reading FIRST, while nothing has been committed
    // yet, so the cursor and its version still look untouched. Only the lease
    // token tells it apart from the legitimate holder.
    staleRelease.release();
    expect(await stale).toMatchObject({ status: "FAILED", errorCode: "lease_lost" });
    expect(await stored()).toHaveLength(0);

    currentRelease.release();
    expect(await current).toMatchObject({ status: "SUCCEEDED", added: 1 });
    expect((await stored()).map((t) => t.providerTransactionId)).toEqual(["from_current_worker"]);
    expect((await itemRow(item.id)).syncCursor).toBe("good_cursor");
  });

  it("rejects a commit if the cursor moved while it was fetching", async () => {
    const { householdId, item } = await setup();
    const entered = deferred();
    const release = deferred();
    api.transactionsSync.mockImplementationOnce(async () => {
      entered.release();
      await release.promise;
      return syncPage({ added: [txn({ transaction_id: "t1", account_id: CHECKING })], next_cursor: "mine" });
    });

    const running = syncItem(deps(), householdId, item.id);
    await entered.promise;
    await owner.plaidItem.update({ where: { id: item.id }, data: { syncCursor: "someone_else", syncCursorVersion: 7 } });
    release.release();

    expect(await running).toMatchObject({ status: "FAILED", errorCode: "cursor_conflict" });
    expect(await stored()).toHaveLength(0);
    expect(await itemRow(item.id)).toMatchObject({ syncCursor: "someone_else", syncCursorVersion: 7 });
  });

  it("extends its lease while it keeps working through pages", async () => {
    const { householdId, item } = await setup();
    const seen: number[] = [];
    api.transactionsSync
      .mockImplementationOnce(async () => syncPage({ added: [txn({ transaction_id: "t1", account_id: CHECKING })], next_cursor: "c1", has_more: true }))
      .mockImplementationOnce(async () => {
        seen.push((await itemRow(item.id)).syncLeaseExpiresAt!.getTime());
        clock = new Date(clock.getTime() + 4 * 60_000); // a slow page
        return syncPage({ added: [txn({ transaction_id: "t2", account_id: CHECKING })], next_cursor: "c2", has_more: true });
      })
      .mockImplementationOnce(async () => {
        seen.push((await itemRow(item.id)).syncLeaseExpiresAt!.getTime());
        return syncPage({ next_cursor: "c3" });
      });

    const summary = await syncItem(deps(), householdId, item.id);

    expect(summary.status).toBe("SUCCEEDED");
    expect(seen[1]).toBeGreaterThan(seen[0]); // the lease moved forward as pages completed
  });
});

describe("who and when", () => {
  it("cannot sync another household's connection, and never calls Plaid", async () => {
    const mine = await seedPerson(owner, "a@example.test");
    const theirs = await seedPerson(owner, "b@example.test");
    const theirItem = await seedConnection(owner, theirs.householdId);

    await expect(syncItem(deps(), mine.householdId, theirItem.id)).rejects.toMatchObject({ code: "connection_not_found" });
    expect(api.transactionsSync).not.toHaveBeenCalled();
    expect(await owner.syncRun.count()).toBe(0);
  });

  it("refuses a disconnected connection, and one that needs a sign-in first", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const closed = await seedConnection(owner, person.householdId, { status: "DISCONNECTED", token: null, plaidItemId: "item_closed" });
    const reauth = await seedConnection(owner, person.householdId, { status: "LOGIN_REQUIRED", plaidItemId: "item_reauth" });

    await expect(syncItem(deps(), person.householdId, closed.id)).rejects.toMatchObject({ code: "connection_not_found" });
    await expect(syncItem(deps(), person.householdId, reauth.id)).rejects.toMatchObject({ code: "reconnect_required" });
    expect(api.transactionsSync).not.toHaveBeenCalled();
  });

  it("fails clearly, without taking the lease, if the stored token cannot be read", async () => {
    const { householdId, item } = await setup();
    const otherKey = createTokenCipher({ current: { keyId: "k1", key: Buffer.alloc(32, 1) } });

    await expect(
      syncItem(
        deps({}, app, { tokens: { encrypt: otherKey.encryptToken, decrypt: otherKey.decryptToken } }),
        householdId,
        item.id,
      ),
    ).rejects.toMatchObject({ code: "token_unreadable" });
    expect((await itemRow(item.id)).syncLeaseToken).toBeNull();
    expect(api.transactionsSync).not.toHaveBeenCalled();
  });

  it("throttles manual syncs: a recent run blocks a repeat until the interval has passed", async () => {
    const { householdId, item } = await setup();
    const options = { minIntervalMs: 60_000 };
    await syncItem(deps(), householdId, item.id, options);

    clock = new Date(clock.getTime() + 20_000);
    await expect(syncItem(deps(), householdId, item.id, options)).rejects.toMatchObject({
      code: "sync_throttled",
      retryAfterSeconds: 40,
    });
    expect(api.transactionsSync).toHaveBeenCalledTimes(1);

    clock = new Date(clock.getTime() + 41_000);
    await expect(syncItem(deps(), householdId, item.id, options)).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("does not throttle the explicit command-line path", async () => {
    const { householdId, item } = await setup();
    await syncItem(deps(), householdId, item.id);

    await expect(syncItem(deps(), householdId, item.id)).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("returns only a summary: no cursor, token or provider ids", async () => {
    const { householdId, item } = await setup();
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({ added: [txn({ transaction_id: "t1", account_id: CHECKING })], next_cursor: "secret_cursor_value" }),
    );

    const summary = await syncItem(deps(), householdId, item.id);

    expect(Object.keys(summary).sort()).toEqual(["added", "completedAt", "errorCode", "modified", "providerStatus", "removed", "runId", "status"]);
    expect(JSON.stringify(summary)).not.toContain("secret_cursor_value");
    expect(JSON.stringify(summary)).not.toContain(ACCESS_TOKEN);
    expect(summary.completedAt).toEqual(clock);
  });
});
