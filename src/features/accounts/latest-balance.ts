import "server-only";
import type { BalanceSnapshot, Prisma, PrismaClient } from "@/generated/prisma/client";
import { latestByAccount } from "@/features/forecast/snapshots";

/**
 * Each account's latest balance, by the forecast's rule (src/features/forecast/
 * snapshots.ts): the newest typed-in balance and the newest bank balance of each
 * account are read, and the rule picks between them.
 *
 * Without a time zone (none chosen yet), typed-in and bank balances are compared
 * by UTC date. A balance the bank did not report (null) is skipped, as in the
 * forecast, so it never becomes the latest.
 */
export async function latestBalances(
  db: PrismaClient | Prisma.TransactionClient,
  accountIds: readonly string[],
  timeZone: string | null,
): Promise<Map<string, BalanceSnapshot>> {
  if (accountIds.length === 0) return new Map();
  const ids = [...accountIds];
  const [typed, fromBank] = await Promise.all([
    db.balanceSnapshot.findMany({
      where: { accountId: { in: ids }, source: "MANUAL", current: { not: null } },
      distinct: ["accountId"],
      orderBy: [{ accountId: "asc" }, { asOfDate: "desc" }, { observedAt: "desc" }],
    }),
    db.balanceSnapshot.findMany({
      where: { accountId: { in: ids }, source: { not: "MANUAL" }, current: { not: null } },
      distinct: ["accountId"],
      orderBy: [{ accountId: "asc" }, { observedAt: "desc" }],
    }),
  ]);
  return latestByAccount([...typed, ...fromBank], timeZone ?? "UTC");
}
