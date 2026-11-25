import "server-only";
import type { PlaidEnvironment, PrismaClient } from "@/generated/prisma/client";
import { latestBalances } from "@/features/accounts/latest-balance";

/**
 * Household-scoped reads for the connections and accounts pages. Each takes the
 * household id from the signed-in session and filters on it (and on the active
 * Plaid environment, so Sandbox and live data are never shown together). The
 * access token and sync cursor are omitted: pages cannot leak what they never
 * load.
 */

export function listConnections(db: PrismaClient, householdId: string, environment: PlaidEnvironment) {
  return db.plaidItem.findMany({
    where: { householdId, environment },
    omit: { accessTokenCiphertext: true, syncCursor: true },
    // The accounts, so pages can count those the bank still reports versus those
    // merely kept as history, and offer to attach the ones not yet attached.
    include: {
      accounts: {
        select: { id: true, name: true, mask: true, type: true, subtype: true, active: true, attachedAt: true },
        orderBy: { name: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Every account the page may show: those entered by hand, plus those from
 * connections in the active Plaid environment (so Sandbox and live data are
 * never shown together), each with its latest balance by the forecast's rule
 * (src/features/accounts/latest-balance.ts).
 */
export async function listAccountsWithLatestBalance(
  db: PrismaClient,
  householdId: string,
  environment: PlaidEnvironment,
  timeZone: string | null,
) {
  const accounts = await db.account.findMany({
    where: { householdId, OR: [{ plaidItemId: null }, { plaidItem: { environment } }] },
    include: { plaidItem: { select: { id: true, institutionName: true, status: true } } },
    orderBy: [{ archivedAt: { sort: "desc", nulls: "first" } }, { plaidItem: { createdAt: "asc" } }, { name: "asc" }],
  });
  const latest = await latestBalances(db, accounts.map((account) => account.id), timeZone);
  return accounts.map((account) => ({ ...account, balance: latest.get(account.id) ?? null }));
}

/**
 * Live transactions, newest first. A transaction Plaid removed, or that a posted
 * one replaced, is excluded here so it can never be counted twice. Scoped to the
 * household through the account it belongs to.
 */
export function listRecentTransactions(
  db: PrismaClient,
  householdId: string,
  environment: PlaidEnvironment,
  take = 200,
) {
  return db.transaction.findMany({
    where: { removedAt: null, account: { householdId, plaidItem: { environment } } },
    include: {
      account: { select: { name: true, mask: true, attachedAt: true, plaidItem: { select: { institutionName: true } } } },
      payment: { select: { ruleId: true, source: true, rule: { select: { name: true } } } },
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take,
  });
}

/** Each connected bank with its most recent sync run, for the Sync panel. */
export function listSyncStatus(db: PrismaClient, householdId: string, environment: PlaidEnvironment) {
  return db.plaidItem.findMany({
    where: { householdId, environment, status: { not: "DISCONNECTED" } },
    // The cursor and the lease token are internal: never loaded into a page.
    omit: { accessTokenCiphertext: true, syncCursor: true, syncLeaseToken: true },
    include: { syncRuns: { orderBy: { startedAt: "desc" }, take: 1 } },
    orderBy: { createdAt: "asc" },
  });
}
