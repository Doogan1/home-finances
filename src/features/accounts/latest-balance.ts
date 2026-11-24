import "server-only";
import type { BalanceSnapshot, Prisma, PrismaClient } from "@/generated/prisma/client";
import { latestByAccount } from "@/features/forecast/snapshots";

/**
 * Each account's latest balance, by the forecast's rule (src/features/forecast/
 * snapshots.ts): the newest typed-in balance and the newest bank balance of each
 * account are read, and the rule picks between them.
 *
 * Without a time zone (none chosen yet) bank balances are dated in UTC. Typed-in
 * balances need a time zone, so that case only ever compares bank balances with
 * each other, where the date makes no difference.
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
      where: { accountId: { in: ids }, source: "MANUAL" },
      distinct: ["accountId"],
      orderBy: [{ accountId: "asc" }, { asOfDate: "desc" }, { observedAt: "desc" }],
    }),
    db.balanceSnapshot.findMany({
      where: { accountId: { in: ids }, source: { not: "MANUAL" } },
      distinct: ["accountId"],
      orderBy: [{ accountId: "asc" }, { observedAt: "desc" }],
    }),
  ]);
  return latestByAccount([...typed, ...fromBank], timeZone ?? "UTC");
}
