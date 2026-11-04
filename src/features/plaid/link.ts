import "server-only";
import { Prisma, type LinkAttemptKind, type LinkAttemptStatus, type PrismaClient } from "@/generated/prisma/client";
import { TokenCryptoError, plaidItemTokenContext } from "@/lib/crypto/tokens";
import { refreshItemAccounts } from "./accounts";
import {
  PlaidFlowError,
  PlaidProviderError,
  type ExchangeResult,
  type LinkAttemptStart,
  type LinkDeps,
} from "./types";

/**
 * The server side of connecting (or reconnecting) a bank through Plaid Link.
 *
 *   createLinkAttempt   -> a short-lived attempt, bound to household + browser
 *                          session, and a Plaid link token for the browser
 *   exchangeLinkAttempt -> finishes it. For a new connection: trades Link's
 *                          one-time public token for an access token, stores it
 *                          encrypted and fetches accounts. For a reconnect
 *                          (update mode): the access token does not change, so
 *                          nothing is exchanged; the connection is re-checked.
 *   resumeLinkAttempt   -> for banks that use OAuth, returns the attempt's
 *                          original link token to the redirect page
 *
 * A public token can be exchanged exactly once, so this flow is built around
 * never doing that twice and never losing track of an exchange that may have
 * happened. The sequence for a NEW connection, and what each failure leaves:
 *
 *   1. claim the attempt      PENDING -> EXCHANGING in one atomic update, so a
 *                             replay or a second tab loses the race
 *   2. exchange at Plaid      definite refusal -> FAILED; no answer / server
 *                             error -> NEEDS_RECONCILIATION (the token may have
 *                             been consumed, so it is never retried)
 *   3. save Item + token      one transaction that also marks the attempt
 *                             COMPLETED. If it fails the access token exists
 *                             only in memory: record Plaid's item id on the
 *                             attempt, ask Plaid to remove the orphan Item,
 *                             and leave NEEDS_RECONCILIATION
 *   4. fetch accounts         a separate, retryable step. Its failure leaves a
 *                             connected Item in PENDING with an error code
 *
 * Stale EXCHANGING attempts (the process died mid-flow) are treated like
 * NEEDS_RECONCILIATION; see docs/plaid-link.md.
 */

const ATTEMPT_LIFETIME_MS = 30 * 60 * 1000;
const REQUESTED_HISTORY_DAYS = 90;

/** Binds a stored link token to its attempt, so it cannot be decrypted as another's. */
const linkTokenContext = (attemptId: string) => `link-attempt:${attemptId}`;

const clock = (deps: LinkDeps) => (deps.now ?? (() => new Date()))();

export function createLinkAttempt(deps: LinkDeps, householdId: string, sessionId: string): Promise<LinkAttemptStart> {
  return beginAttempt(deps, { kind: "CONNECT", householdId, sessionId });
}

/**
 * Shared by new connections and reconnects (see lifecycle.ts). Records the
 * attempt first, then asks Plaid for a link token; if Plaid refuses, the attempt
 * is closed with a safe code.
 */
export async function beginAttempt(
  deps: LinkDeps,
  input: {
    kind: LinkAttemptKind;
    householdId: string;
    sessionId: string;
    /** Reconnect only: the connection being repaired, and its decrypted access token. */
    connection?: { id: string; accessToken: string };
  },
): Promise<LinkAttemptStart> {
  const { db, plaid, tokens, redirectUri } = deps;
  const now = clock(deps);
  const attempt = await db.linkAttempt.create({
    data: {
      kind: input.kind,
      householdId: input.householdId,
      sessionId: input.sessionId,
      environment: deps.environment,
      plaidItemId: input.connection?.id,
      expiresAt: new Date(now.getTime() + ATTEMPT_LIFETIME_MS),
      requestedHistoryDays: input.kind === "CONNECT" ? REQUESTED_HISTORY_DAYS : null,
    },
  });

  try {
    const { linkToken } = await plaid.createLinkToken({
      // The household id is stable and opaque to Plaid; it carries no personal data.
      clientUserId: input.householdId,
      historyDays: REQUESTED_HISTORY_DAYS,
      redirectUri: redirectUri ?? undefined,
      accessToken: input.connection?.accessToken,
    });
    if (redirectUri) {
      // Only needed if the bank sends the person away (OAuth): the return page
      // must reopen Link with this same token. Encrypted, bound to this
      // attempt, and cleared as soon as the attempt ends.
      await db.linkAttempt.update({
        where: { id: attempt.id },
        data: { linkTokenCiphertext: tokens.encrypt(linkToken, linkTokenContext(attempt.id)) },
      });
    }
    return { attemptId: attempt.id, linkToken };
  } catch (error) {
    if (error instanceof PlaidProviderError) {
      await settleAttempt(db, attempt.id, "FAILED", error.code ?? error.kind);
      throw new PlaidFlowError("provider_error", error);
    }
    throw error;
  }
}

/**
 * Returns an attempt's original link token to the OAuth return page. Only the
 * browser session that started the attempt may have it, and only while the
 * attempt is still open.
 */
export async function resumeLinkAttempt(
  deps: LinkDeps,
  householdId: string,
  sessionId: string,
  attemptId: string,
): Promise<LinkAttemptStart> {
  const { db, tokens, environment } = deps;
  const attempt = await db.linkAttempt.findFirst({ where: { id: attemptId, householdId, sessionId } });
  if (!attempt || attempt.environment !== environment) throw new PlaidFlowError("attempt_not_found");
  if (attempt.status !== "PENDING") throw new PlaidFlowError("attempt_used");
  if (attempt.expiresAt <= clock(deps)) {
    await settleAttempt(db, attempt.id, "FAILED", "attempt_expired", "PENDING");
    throw new PlaidFlowError("attempt_expired");
  }
  if (!attempt.linkTokenCiphertext) throw new PlaidFlowError("attempt_not_found");

  try {
    return { attemptId: attempt.id, linkToken: tokens.decrypt(attempt.linkTokenCiphertext, linkTokenContext(attempt.id)) };
  } catch (error) {
    if (error instanceof TokenCryptoError) throw new PlaidFlowError("attempt_not_found");
    throw error;
  }
}

export async function exchangeLinkAttempt(
  deps: LinkDeps,
  householdId: string,
  sessionId: string,
  attemptId: string,
  publicToken: string,
): Promise<ExchangeResult> {
  const { db, plaid, tokens, environment } = deps;
  const now = clock(deps);

  // Household and session are part of the lookup, so someone else's attempt is
  // indistinguishable from one that does not exist.
  const attempt = await db.linkAttempt.findFirst({ where: { id: attemptId, householdId, sessionId } });
  if (!attempt || attempt.environment !== environment) throw new PlaidFlowError("attempt_not_found");
  if (attempt.status !== "PENDING") throw new PlaidFlowError("attempt_used");
  if (attempt.expiresAt <= now) {
    await settleAttempt(db, attempt.id, "FAILED", "attempt_expired", "PENDING");
    throw new PlaidFlowError("attempt_expired");
  }

  // Step 1: claim. Of any number of concurrent requests, exactly one gets count 1.
  const claim = await db.linkAttempt.updateMany({
    where: { id: attempt.id, householdId, sessionId, status: "PENDING", expiresAt: { gt: now } },
    data: { status: "EXCHANGING" },
  });
  if (claim.count !== 1) throw new PlaidFlowError("attempt_used");

  if (attempt.kind === "RECONNECT") return completeReconnect(deps, attempt, householdId);

  // Step 2: exchange.
  let exchanged: { accessToken: string; providerItemId: string };
  try {
    exchanged = await plaid.exchangePublicToken(publicToken);
  } catch (error) {
    if (!(error instanceof PlaidProviderError)) {
      await settleAttempt(db, attempt.id, "NEEDS_RECONCILIATION", "unexpected_error");
      throw error;
    }
    const errorCode = error.code ?? error.kind;
    // Only an outright refusal proves the token was not consumed.
    const definitelyRefused = ["invalid_public_token", "rate_limited", "misconfigured", "missing_entitlement"];
    await settleAttempt(db, attempt.id, definitelyRefused.includes(error.kind) ? "FAILED" : "NEEDS_RECONCILIATION", errorCode);
    throw error.kind === "invalid_public_token"
      ? new PlaidFlowError("invalid_public_token", error)
      : new PlaidFlowError("provider_error", error);
  }

  // Step 3: save the Item with its encrypted token and complete the attempt.
  let connectionId: string;
  try {
    const ciphertext = tokens.encrypt(
      exchanged.accessToken,
      plaidItemTokenContext(environment, exchanged.providerItemId),
    );
    connectionId = await db.$transaction(async (tx) => {
      const item = await tx.plaidItem.create({
        data: {
          householdId,
          environment,
          plaidItemId: exchanged.providerItemId,
          accessTokenCiphertext: ciphertext,
          status: "PENDING",
        },
        select: { id: true },
      });
      await tx.linkAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "COMPLETED",
          completedAt: now,
          plaidItemId: item.id,
          providerItemId: exchanged.providerItemId,
          linkTokenCiphertext: null,
        },
      });
      return item.id;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Plaid handed back an Item we already store. Keep the existing one;
      // removing "the new" Item at Plaid would destroy the connection we keep.
      await settleAttempt(db, attempt.id, "FAILED", "duplicate_item", undefined, exchanged.providerItemId);
      throw new PlaidFlowError("duplicate_item");
    }
    await settleAttempt(db, attempt.id, "NEEDS_RECONCILIATION", "persistence_failed", undefined, exchanged.providerItemId);
    // Best effort: do not leave a live Item at Plaid that nothing here can use.
    await plaid.removeItem(exchanged.accessToken).catch(() => undefined);
    throw new PlaidFlowError("persistence_failed");
  }

  // Step 4: accounts. Failure here is not a failed link; the Item is saved and
  // the fetch can be retried without touching the (consumed) public token.
  try {
    const refreshed = await refreshItemAccounts(deps, householdId, connectionId);
    return { connectionId, status: refreshed.status };
  } catch {
    return { connectionId, status: "PENDING" };
  }
}

/**
 * Update mode: Plaid has already repaired the connection inside Link and the
 * access token is unchanged, so there is nothing to exchange. Close the attempt,
 * then re-fetch accounts, which clears the "sign-in needed" state on success and
 * restores it if the bank still refuses.
 */
async function completeReconnect(
  deps: LinkDeps,
  attempt: { id: string; plaidItemId: string | null },
  householdId: string,
): Promise<ExchangeResult> {
  const { db } = deps;
  if (!attempt.plaidItemId) {
    await settleAttempt(db, attempt.id, "FAILED", "connection_missing");
    throw new PlaidFlowError("connection_not_found");
  }
  const connectionId = attempt.plaidItemId;
  await db.linkAttempt.update({
    where: { id: attempt.id },
    data: { status: "COMPLETED", completedAt: clock(deps), linkTokenCiphertext: null },
  });

  try {
    const refreshed = await refreshItemAccounts(deps, householdId, connectionId);
    return { connectionId, status: refreshed.status };
  } catch (error) {
    if (error instanceof PlaidFlowError && error.code === "connection_not_found") throw error;
    const item = await db.plaidItem.findUnique({ where: { id: connectionId }, select: { status: true } });
    return { connectionId, status: item?.status ?? "PENDING" };
  }
}

/**
 * Best-effort record of how an attempt ended. The stored link token is always
 * cleared, because an ended attempt has no further use for it. Failures are
 * swallowed so the original error, not a bookkeeping error, reaches the caller.
 * `onlyFrom` restricts the update to attempts still in that state.
 */
async function settleAttempt(
  db: PrismaClient,
  attemptId: string,
  status: LinkAttemptStatus,
  errorCode: string,
  onlyFrom?: LinkAttemptStatus,
  providerItemId?: string,
): Promise<void> {
  await db.linkAttempt
    .updateMany({
      where: { id: attemptId, ...(onlyFrom ? { status: onlyFrom } : {}) },
      data: { status, errorCode, linkTokenCiphertext: null, ...(providerItemId ? { providerItemId } : {}) },
    })
    .catch(() => undefined);
}
