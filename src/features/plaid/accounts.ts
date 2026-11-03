import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { plaidItemTokenContext, TokenCryptoError } from "@/lib/crypto/tokens";
import {
  PlaidFlowError,
  PlaidProviderError,
  type LinkDeps,
  type ProviderAccounts,
  type RefreshResult,
} from "./types";

/**
 * Fetches the authoritative account list for a connection from Plaid
 * (/accounts/get) and records it: accounts are upserted by Plaid's account id,
 * accounts Plaid stopped returning are marked unavailable (never deleted), and
 * every call appends one timestamped balance observation per account.
 *
 * Safe to call repeatedly. It never exchanges a public token, so it is also the
 * retry path when the first fetch after linking failed.
 */
export async function refreshItemAccounts(
  deps: LinkDeps,
  householdId: string,
  connectionId: string,
): Promise<RefreshResult> {
  const { db, plaid, tokens, environment } = deps;
  const now = (deps.now ?? (() => new Date()))();

  // Household and environment are part of the query: another household's
  // connection, or one made against a different Plaid environment, is simply
  // not found.
  const item = await db.plaidItem.findFirst({ where: { id: connectionId, householdId, environment } });
  if (!item || !item.accessTokenCiphertext) throw new PlaidFlowError("connection_not_found");

  let accessToken: string;
  try {
    accessToken = tokens.decrypt(item.accessTokenCiphertext, plaidItemTokenContext(item.environment, item.plaidItemId));
  } catch (error) {
    if (error instanceof TokenCryptoError) throw new PlaidFlowError("token_unreadable");
    throw error;
  }

  let fetched: ProviderAccounts;
  try {
    fetched = await plaid.getAccounts(accessToken);
  } catch (error) {
    if (!(error instanceof PlaidProviderError)) throw error;
    const errorCode = error.code ?? error.kind;
    const updated = await db.plaidItem.update({
      where: { id: item.id },
      data: {
        // Only "the login must be redone" changes what the user has to do.
        status: error.kind === "login_required" ? "LOGIN_REQUIRED" : item.status,
        lastErrorCode: errorCode,
        lastErrorAt: now,
      },
    });
    return { status: updated.status, accountCount: await countActiveAccounts(deps, item.id), errorCode };
  }

  // Never ingest accounts that Plaid says belong to a different Item.
  if (fetched.providerItemId !== item.plaidItemId) throw new PlaidFlowError("persistence_failed");

  try {
    await db.$transaction(async (tx) => {
      const existing = await tx.account.findMany({
        where: { plaidItemId: item.id },
        select: { id: true, externalAccountId: true, active: true },
      });
      const returned = new Set<string>();

      for (const provided of fetched.accounts) {
        returned.add(provided.externalAccountId);
        const account = await tx.account.upsert({
          where: {
            plaidItemId_externalAccountId: { plaidItemId: item.id, externalAccountId: provided.externalAccountId },
          },
          create: {
            householdId,
            plaidItemId: item.id,
            externalAccountId: provided.externalAccountId,
            name: provided.name,
            officialName: provided.officialName,
            mask: provided.mask,
            type: provided.type,
            subtype: provided.subtype,
            currency: provided.currency,
          },
          update: {
            name: provided.name,
            officialName: provided.officialName,
            mask: provided.mask,
            type: provided.type,
            subtype: provided.subtype,
            currency: provided.currency,
            active: true,
            unavailableSince: null,
          },
        });
        await tx.balanceSnapshot.create({
          data: {
            accountId: account.id,
            observedAt: now,
            providerUpdatedAt: provided.providerUpdatedAt,
            // Strings keep Plaid's exact decimal; null stays "not reported".
            available: toDecimal(provided.balances.available),
            current: toDecimal(provided.balances.current),
            limit: toDecimal(provided.balances.limit),
            currency: provided.currency,
            source: "ACCOUNTS_GET",
          },
        });
      }

      const vanished = existing.filter((a) => a.active && !returned.has(a.externalAccountId));
      if (vanished.length > 0) {
        await tx.account.updateMany({
          where: { id: { in: vanished.map((a) => a.id) } },
          data: { active: false, unavailableSince: now },
        });
      }

      await tx.plaidItem.update({
        where: { id: item.id },
        data: {
          status: "ACTIVE",
          institutionId: fetched.institutionId ?? item.institutionId,
          institutionName: fetched.institutionName ?? item.institutionName,
          lastErrorCode: null,
          lastErrorAt: null,
        },
      });
    });
  } catch {
    // The provider call worked but nothing was saved; the transaction rolled back.
    throw new PlaidFlowError("persistence_failed");
  }

  return { status: "ACTIVE", accountCount: fetched.accounts.length, errorCode: null };
}

function toDecimal(value: string | null): Prisma.Decimal | null {
  return value === null ? null : new Prisma.Decimal(value);
}

function countActiveAccounts(deps: LinkDeps, connectionId: string): Promise<number> {
  return deps.db.account.count({ where: { plaidItemId: connectionId, active: true } });
}
