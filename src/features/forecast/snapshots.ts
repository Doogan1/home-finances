import { todayIn, toIsoDate, type IsoDate } from "@/lib/calendar-date";

/**
 * Which balance is an account's latest. A hand-entered balance is true at the
 * end of its `asOfDate`; a balance from the bank is dated by the household-local
 * day it was observed. The later date wins, and on the same date the later
 * observation wins. Build step 6 (attaching a bank account to a hand-entered
 * one) reuses this, since one account can then have both kinds.
 */

export type SnapshotRow = { accountId: string; asOfDate: Date | null; observedAt: Date; current: string };
export type LatestSnapshot = { accountId: string; date: IsoDate; observedAt: Date; balance: string };

export function snapshotDate(row: Pick<SnapshotRow, "asOfDate" | "observedAt">, timeZone: string): IsoDate {
  return row.asOfDate ? toIsoDate(row.asOfDate) : todayIn(timeZone, row.observedAt);
}

function isLater(candidate: LatestSnapshot, best: LatestSnapshot): boolean {
  if (candidate.date !== best.date) return candidate.date > best.date;
  return candidate.observedAt.getTime() > best.observedAt.getTime();
}

export function latestSnapshots(rows: readonly SnapshotRow[], timeZone: string): Map<string, LatestSnapshot> {
  const latest = new Map<string, LatestSnapshot>();
  for (const row of rows) {
    const candidate: LatestSnapshot = {
      accountId: row.accountId,
      date: snapshotDate(row, timeZone),
      observedAt: row.observedAt,
      balance: row.current,
    };
    const best = latest.get(row.accountId);
    if (!best || isLater(candidate, best)) latest.set(row.accountId, candidate);
  }
  return latest;
}
