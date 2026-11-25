import { occurrencesBetween, type ForecastOverride, type ForecastRule, type OccurrenceStatus } from "@/features/forecast/occurrences";
import type { IsoDate } from "@/lib/calendar-date";
import type { Cents } from "@/lib/cents";

/**
 * A rule's past, for its own page: every due date in a window with what was
 * planned and what the bank shows was paid, plus payments that have no due
 * date. Newest first. Pure.
 */

export type HistoryPayment = { transactionId: string; scheduledOn: IsoDate | null; date: IsoDate; cents: Cents; payee: string; source: "AUTO" | "PERSON" };
export type HistoryRow = {
  /** Null for payments with no due date (from before the rule's first date). */
  scheduledOn: IsoDate | null;
  /** When it happened, or was due: what the rows are ordered by. */
  date: IsoDate;
  /** What was planned for the date: the person's confirmed amount, or the version's. */
  planned: Cents | null;
  /** The person's own status for the date (it is Paid anyway when there are payments). */
  status: OccurrenceStatus | null;
  payments: HistoryPayment[];
  /** The payments' sum; null when there are none. */
  paid: Cents | null;
};

const total = (payments: readonly HistoryPayment[]) => (payments.length === 0 ? null : payments.reduce((sum, p) => sum + p.cents, 0n));
const lastDate = (payments: readonly HistoryPayment[]) => payments.reduce((max, p) => (p.date > max ? p.date : max), payments[0].date);

/**
 * `overrides` are the person's own edits (not layered with payments), and
 * `rule` carries no typical amount, so `planned` is what the plan said. Due
 * dates from `from` to `today` are listed, and any later one already paid.
 */
export function paymentHistory(
  rule: ForecastRule,
  overrides: readonly ForecastOverride[],
  payments: readonly HistoryPayment[],
  from: IsoDate,
  today: IsoDate,
): HistoryRow[] {
  const own = overrides.filter((o) => o.ruleId === rule.id);
  const byDue = new Map<IsoDate, HistoryPayment[]>();
  for (const payment of payments) {
    if (payment.scheduledOn !== null) byDue.set(payment.scheduledOn, [...(byDue.get(payment.scheduledOn) ?? []), payment]);
  }
  const paidDates = [...byDue.keys()].sort();
  const to = paidDates.length > 0 && paidDates[paidDates.length - 1] > today ? paidDates[paidDates.length - 1] : today;

  // The plan as the person left it, on the dates the rule gave: moves are shown, not applied.
  const moved = new Map(own.map((o) => [o.scheduledOn, o.movedTo]));
  const planned = occurrencesBetween([{ ...rule, typical: undefined }], own.map((o) => ({ ...o, movedTo: null })), from, to);
  const due: HistoryRow[] = planned.flatMap((occurrence) => {
    const paid = byDue.get(occurrence.scheduledOn) ?? [];
    if (occurrence.scheduledOn > today && paid.length === 0) return [];
    return [
      {
        scheduledOn: occurrence.scheduledOn,
        date: paid.length > 0 ? lastDate(paid) : (moved.get(occurrence.scheduledOn) ?? occurrence.scheduledOn),
        planned: occurrence.amount,
        status: occurrence.status,
        payments: paid,
        paid: total(paid),
      },
    ];
  });
  const loose: HistoryRow[] = payments
    .filter((p) => p.scheduledOn === null && p.date >= from)
    .map((p) => ({ scheduledOn: null, date: p.date, planned: null, status: null, payments: [p], paid: p.cents }));
  return [...due, ...loose].sort((a, b) => b.date.localeCompare(a.date) || (b.scheduledOn ?? "").localeCompare(a.scheduledOn ?? ""));
}
