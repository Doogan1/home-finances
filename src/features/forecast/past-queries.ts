import "server-only";
import type { PlaidEnvironment, PrismaClient } from "@/generated/prisma/client";
import { addDays, toIsoDate } from "@/lib/calendar-date";
import { toCents } from "@/lib/cents";
import type { AccountSeries } from "./engine";
import { pastDays, type PastDay } from "./past";
import { snapshotDate } from "./snapshots";

/** How many days of the past the chart shows before the forecast. */
export const PAST_CHART_DAYS = 30;
/** The furthest back any page looks. */
export const PAST_MAX_DAYS = 365;

/**
 * One account's balances for the `days` days before its forecast begins. The
 * account is looked up within the session's household. Saved balances are
 * dated the way the forecast dates them; bank transactions count once posted,
 * and are signed the household's way (money in is positive).
 */
export async function loadAccountPast(
  db: PrismaClient,
  householdId: string,
  series: AccountSeries,
  options: { environment: PlaidEnvironment; timeZone: string; days: number },
): Promise<PastDay[]> {
  const to = addDays(series.days[0].date, -1);
  const from = addDays(to, 1 - Math.min(options.days, PAST_MAX_DAYS));
  const account = { id: series.account.id, householdId };
  const posted = { account: { ...account, plaidItem: { environment: options.environment } }, removedAt: null, pending: false };
  const [balances, transactions, first] = await Promise.all([
    db.balanceSnapshot.findMany({
      where: { account, current: { not: null } },
      select: { asOfDate: true, observedAt: true, current: true },
    }),
    db.transaction.findMany({
      where: { ...posted, date: { gte: new Date(`${from}T00:00:00.000Z`) } },
      select: {
        id: true,
        date: true,
        amount: true,
        description: true,
        merchantName: true,
        payment: { select: { ruleId: true, rule: { select: { name: true } } } },
      },
    }),
    db.transaction.findFirst({ where: posted, orderBy: { date: "asc" }, select: { date: true } }),
  ]);
  return pastDays({
    bankSince: first ? toIsoDate(first.date) : null,
    from,
    to,
    balances: balances.flatMap((row) =>
      row.current === null ? [] : [{ date: snapshotDate(row, options.timeZone), observedAt: row.observedAt, cents: toCents(row.current.toFixed()) }],
    ),
    transactions: transactions.map((row) => ({
      id: row.id,
      date: toIsoDate(row.date),
      // The bank reports money leaving as positive.
      cents: -toCents(row.amount.toFixed()),
      payee: row.merchantName ?? row.description,
      ruleId: row.payment?.ruleId ?? null,
      ruleName: row.payment?.rule.name ?? null,
    })),
  });
}
