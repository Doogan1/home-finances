import { addDays, type IsoDate } from "@/lib/calendar-date";
import type { Cents } from "@/lib/cents";

/**
 * What an account's balance was on the days before the forecast begins, from
 * what is saved: balances (typed, or read from the bank) and, for an account
 * with a bank attached, its posted transactions. Pure.
 *
 * - A day with a saved balance has that balance.
 * - Otherwise, with bank transactions, the day is worked back from the next
 *   day: that day's balance less that day's net transactions.
 * - Otherwise the day carries the last saved balance before it.
 *
 * Days before anything is known are left out, so the result may be shorter
 * than the window asked for (or empty).
 */

export type PastBalance = { date: IsoDate; observedAt: Date; cents: Cents };
/** `cents` is signed the household's way: money in is positive, money out negative. */
export type PastTransaction = { id: string; date: IsoDate; cents: Cents; payee: string; ruleId: string | null; ruleName: string | null };
export type PastDay = {
  date: IsoDate;
  closing: Cents;
  /** How the balance is known: saved for that day, worked back from transactions, or carried from an earlier day. */
  from: "saved" | "worked" | "carried";
  transactions: PastTransaction[];
};

export type PastInput = {
  /** The window wanted, both ends included. `to` is the day before the forecast's first day. */
  from: IsoDate;
  to: IsoDate;
  /** Every saved balance up to the account's latest, in any order. */
  balances: readonly PastBalance[];
  /** Posted transactions dated `from` or later. */
  transactions: readonly PastTransaction[];
  /** The date of the account's first bank transaction ever (it may be before `from`); null for an account kept by hand. */
  bankSince: IsoDate | null;
};

export function pastDays(input: PastInput): PastDay[] {
  if (input.to < input.from) return [];
  // The balance for a date is the one observed last.
  const saved = new Map<IsoDate, PastBalance>();
  for (const balance of input.balances) {
    const best = saved.get(balance.date);
    if (!best || balance.observedAt.getTime() > best.observedAt.getTime()) saved.set(balance.date, balance);
  }
  if (saved.size === 0) return [];
  const dates = [...saved.keys()].sort();
  const latest = dates[dates.length - 1];

  const byDate = new Map<IsoDate, PastTransaction[]>();
  for (const transaction of input.transactions) byDate.set(transaction.date, [...(byDate.get(transaction.date) ?? []), transaction]);
  const net = (date: IsoDate) => (byDate.get(date) ?? []).reduce((sum, t) => sum + t.cents, 0n);
  // Nothing is known before the first balance or (with a bank) the first transaction.
  const known = input.bankSince !== null && input.bankSince < dates[0] ? input.bankSince : dates[0];
  const start = known > input.from ? known : input.from;

  // Backwards from the latest balance, so each day can lean on the day after it.
  const days: PastDay[] = [];
  let next: Cents | null = null;
  for (let date = latest > input.to ? latest : input.to; date >= start; date = addDays(date, -1)) {
    const here = saved.get(date);
    let day: Pick<PastDay, "closing" | "from"> | null = null;
    if (here) day = { closing: here.cents, from: "saved" };
    // Working back needs the next day's transactions, which are only known from the bank's first one on.
    else if (input.bankSince !== null && next !== null && addDays(date, 1) >= input.bankSince) day = { closing: next - net(addDays(date, 1)), from: "worked" };
    else {
      const earlier = dates.filter((d) => d < date).pop();
      if (earlier !== undefined) day = { closing: (saved.get(earlier) as PastBalance).cents, from: "carried" };
    }
    next = day?.closing ?? null;
    if (day && date <= input.to) days.push({ date, ...day, transactions: byDate.get(date) ?? [] });
  }
  return days.reverse();
}

export type PastRow = { date: IsoDate; transaction: PastTransaction; balance: Cents };

/** The past as a checkbook: each transaction with the balance after it, money in first within a day. */
export function pastRows(days: readonly PastDay[]): PastRow[] {
  return days.flatMap((day) => {
    const ordered = [...day.transactions].sort((a, b) => (a.cents > 0n ? 0 : 1) - (b.cents > 0n ? 0 : 1) || a.payee.localeCompare(b.payee) || a.id.localeCompare(b.id));
    let balance = ordered.reduce((sum, t) => sum - t.cents, day.closing);
    return ordered.map((transaction) => {
      balance += transaction.cents;
      return { date: day.date, transaction, balance };
    });
  });
}
