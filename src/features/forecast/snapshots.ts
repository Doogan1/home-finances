import { todayIn, toIsoDate, type IsoDate } from "@/lib/calendar-date";

/**
 * Which balance is an account's latest. A hand-entered balance is true at the
 * end of its `asOfDate`; a balance from the bank is dated by the household-local
 * day it was observed. The later date wins, and on the same date the later
 * observation wins. The forecast, the Accounts page and Update balances all use
 * this, since an account with a bank attached has both kinds.
 */

export type SnapshotRow = { accountId: string; asOfDate: Date | null; observedAt: Date; current: string };
export type LatestSnapshot = { accountId: string; date: IsoDate; observedAt: Date; balance: string };
type Dated = Pick<SnapshotRow, "asOfDate" | "observedAt">;

export function snapshotDate(row: Dated, timeZone: string): IsoDate {
  return row.asOfDate ? toIsoDate(row.asOfDate) : todayIn(timeZone, row.observedAt);
}

/** True when `candidate` is a later balance than `best`: a later date, or the same date observed later. */
export function isLaterSnapshot(candidate: Dated, best: Dated, timeZone: string): boolean {
  const candidateDate = snapshotDate(candidate, timeZone);
  const bestDate = snapshotDate(best, timeZone);
  if (candidateDate !== bestDate) return candidateDate > bestDate;
  return candidate.observedAt.getTime() > best.observedAt.getTime();
}

/** Each account's latest row, kept whole (pages show more than the balance). */
export function latestByAccount<T extends Dated & { accountId: string }>(rows: readonly T[], timeZone: string): Map<string, T> {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const best = latest.get(row.accountId);
    if (!best || isLaterSnapshot(row, best, timeZone)) latest.set(row.accountId, row);
  }
  return latest;
}

export function latestSnapshots(rows: readonly SnapshotRow[], timeZone: string): Map<string, LatestSnapshot> {
  const latest = new Map<string, LatestSnapshot>();
  for (const [accountId, row] of latestByAccount(rows, timeZone)) {
    latest.set(accountId, { accountId, date: snapshotDate(row, timeZone), observedAt: row.observedAt, balance: row.current });
  }
  return latest;
}
