import "server-only";
import { plaidItemTokenContext, TokenCryptoError } from "@/lib/crypto/tokens";
import { beginAttempt } from "./link";
import {
  PlaidFlowError,
  PlaidProviderError,
  type DisconnectResult,
  type LinkAttemptStart,
  type LinkDeps,
} from "./types";

/**
 * What can happen to a connection after it exists: reconnecting it when the bank
 * wants a fresh sign-in, disconnecting it, and (separately, after disconnecting)
 * deleting its saved history. Every function looks the connection up by the
 * signed-in household and the configured Plaid environment, so another
 * household's connection is "not found".
 */

/** Set on a connection Plaid could not confirm it removed; the UI tells the person to check the Dashboard. */
export const REMOVAL_UNCONFIRMED = "removal_unconfirmed";

const clock = (deps: LinkDeps) => (deps.now ?? (() => new Date()))();

/**
 * Starts Plaid Link in update mode for an existing connection, using its stored
 * access token. Available for any connection that still has a token (not only a
 * flagged one), since consent can be refreshed before it lapses.
 *
 * `selectAccounts` adds Plaid's account-selection step, the supported way to add
 * accounts to (or drop them from) an existing connection.
 */
export async function createReconnectAttempt(
  deps: LinkDeps,
  householdId: string,
  sessionId: string,
  connectionId: string,
  options: { selectAccounts?: boolean } = {},
): Promise<LinkAttemptStart> {
  const { db, tokens, environment } = deps;
  const item = await db.plaidItem.findFirst({ where: { id: connectionId, householdId, environment } });
  if (!item || !item.accessTokenCiphertext) throw new PlaidFlowError("connection_not_found");

  let accessToken: string;
  try {
    accessToken = tokens.decrypt(item.accessTokenCiphertext, plaidItemTokenContext(item.environment, item.plaidItemId));
  } catch (error) {
    if (error instanceof TokenCryptoError) throw new PlaidFlowError("token_unreadable");
    throw error;
  }

  return beginAttempt(deps, {
    kind: "RECONNECT",
    householdId,
    sessionId,
    connection: { id: item.id, accessToken },
    selectAccounts: options.selectAccounts,
  });
}

/**
 * Removes the connection at Plaid (/item/remove, which also ends billing for
 * it), then erases the stored access token and marks the accounts as no longer
 * reported. Saved balances and history are kept until deleted separately.
 *
 * If Plaid cannot be reached the connection is left exactly as it was, token
 * included, so the same call can simply be repeated. If Plaid says it no longer
 * knows the Item, or the stored token can no longer be decrypted, the connection
 * is still disconnected locally but flagged `removal_unconfirmed`: we cannot
 * prove it is gone at Plaid, and the person should check the Dashboard.
 */
export async function disconnectConnection(
  deps: LinkDeps,
  householdId: string,
  connectionId: string,
): Promise<DisconnectResult> {
  const { db, plaid, tokens, environment } = deps;
  const now = clock(deps);

  const item = await db.plaidItem.findFirst({ where: { id: connectionId, householdId, environment } });
  if (!item) throw new PlaidFlowError("connection_not_found");
  if (item.status === "DISCONNECTED") {
    return { status: "DISCONNECTED", removalConfirmed: item.lastErrorCode !== REMOVAL_UNCONFIRMED };
  }

  let removalConfirmed = true;
  let accessToken: string | null = null;
  try {
    if (item.accessTokenCiphertext) {
      accessToken = tokens.decrypt(item.accessTokenCiphertext, plaidItemTokenContext(item.environment, item.plaidItemId));
    }
  } catch (error) {
    if (!(error instanceof TokenCryptoError)) throw error;
  }
  if (!accessToken) removalConfirmed = false; // nothing usable to ask Plaid with

  if (accessToken) {
    try {
      await plaid.removeItem(accessToken);
    } catch (error) {
      if (!(error instanceof PlaidProviderError)) throw error;
      if (error.kind === "item_gone") {
        removalConfirmed = false;
      } else {
        // Leave the connection fully intact so this can be retried.
        await db.plaidItem
          .update({ where: { id: item.id }, data: { lastErrorCode: error.code ?? error.kind, lastErrorAt: now } })
          .catch(() => undefined);
        throw new PlaidFlowError("provider_error", error);
      }
    }
  }

  await db.$transaction(async (tx) => {
    // Guarded so two simultaneous disconnects do not both rewrite the result.
    const changed = await tx.plaidItem.updateMany({
      where: { id: item.id, status: { not: "DISCONNECTED" } },
      data: {
        status: "DISCONNECTED",
        accessTokenCiphertext: null,
        lastErrorCode: removalConfirmed ? null : REMOVAL_UNCONFIRMED,
        lastErrorAt: removalConfirmed ? null : now,
      },
    });
    if (changed.count === 1) {
      await tx.account.updateMany({
        where: { plaidItemId: item.id, active: true },
        data: { active: false, unavailableSince: now },
      });
    }
  });

  return { status: "DISCONNECTED", removalConfirmed };
}

/**
 * Deletes a DISCONNECTED connection and everything saved under it (accounts,
 * balance observations, transactions). A separate, deliberate step from
 * disconnecting; refuses for a connection that is still connected.
 */
export async function deleteConnectionHistory(
  deps: LinkDeps,
  householdId: string,
  connectionId: string,
): Promise<void> {
  const { db, environment } = deps;
  const item = await db.plaidItem.findFirst({
    where: { id: connectionId, householdId, environment },
    select: { status: true },
  });
  if (!item) throw new PlaidFlowError("connection_not_found");
  if (item.status !== "DISCONNECTED") throw new PlaidFlowError("not_disconnected");

  // The status is part of the delete, so a reconnect racing this cannot lose data.
  const deleted = await db.plaidItem.deleteMany({
    where: { id: connectionId, householdId, status: "DISCONNECTED" },
  });
  if (deleted.count !== 1) throw new PlaidFlowError("not_disconnected");
}
