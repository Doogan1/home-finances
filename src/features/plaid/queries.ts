import "server-only";
import type { PlaidEnvironment, PrismaClient } from "@/generated/prisma/client";

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
    // Just the flags, so pages can count accounts the bank still reports versus
    // accounts merely kept as history.
    include: { accounts: { select: { active: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export function listAccountsWithLatestBalance(
  db: PrismaClient,
  householdId: string,
  environment: PlaidEnvironment,
) {
  return db.account.findMany({
    where: { householdId, plaidItem: { environment } },
    include: {
      plaidItem: { select: { id: true, institutionName: true, status: true } },
      // Only the newest observation; older ones remain as history.
      balances: { orderBy: { observedAt: "desc" }, take: 1 },
    },
    orderBy: [{ plaidItem: { createdAt: "asc" } }, { name: "asc" }],
  });
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
      account: { select: { name: true, mask: true, plaidItem: { select: { institutionName: true } } } },
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
