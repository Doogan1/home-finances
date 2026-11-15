import { ruleOccurrences } from "@/features/rules/recurrence";
import type { IsoDate } from "@/lib/calendar-date";
import { toCents } from "@/lib/cents";
import type { ScheduleEntry } from "./parse";
import type { PlannedRule } from "./plan";

/**
 * The Bill Schedule is not copied; it is a check. For each imported bill, the
 * dates its rule produces from the forecast start to the schedule's last date
 * are compared with that bill's schedule rows. Rows before the forecast start
 * are counted, not compared.
 */

export type AmountDifference = { entry: ScheduleEntry; ruleRef: string; ruleAmount: string };
export type ScheduleComparison = {
  /** null when no schedule row is on or after the forecast start. */
  window: { from: IsoDate; to: IsoDate } | null;
  beforeStart: number;
  /** Rows on a date their bill's rule does not produce. */
  missing: ScheduleEntry[];
  /** Dates a rule produces that have no row. */
  extra: { ruleRef: string; date: IsoDate }[];
  /** Rows on a produced date whose amount differs from the rule's. */
  amounts: AmountDifference[];
  /** Rows whose bill id is not an imported bill. */
  unknownBill: ScheduleEntry[];
  /** Bills paid directly that have no row at all. */
  noRows: string[];
  /** Rows with a status other than Planned, or a confirmed amount: neither is copied. */
  stateNotCopied: ScheduleEntry[];
};

export function compareSchedule(rules: readonly PlannedRule[], schedule: readonly ScheduleEntry[], start: IsoDate): ScheduleComparison {
  const rows = schedule.filter((entry) => entry.dueDate >= start);
  const result: ScheduleComparison = {
    window: null,
    beforeStart: schedule.length - rows.length,
    missing: [],
    extra: [],
    amounts: [],
    unknownBill: [],
    noRows: [],
    stateNotCopied: rows.filter((r) => (r.status !== null && r.status.toLowerCase() !== "planned") || r.confirmed !== null),
  };
  const bills = rules.filter((rule) => rule.kind === "BILL");
  const known = new Set(bills.map((rule) => rule.ref));
  result.unknownBill = rows.filter((entry) => !known.has(entry.billId));
  if (rows.length === 0) return result;

  const to = rows.reduce((max, entry) => (entry.dueDate > max ? entry.dueDate : max), rows[0].dueDate);
  result.window = { from: start, to };
  for (const rule of bills) {
    const own = rows.filter((entry) => entry.billId === rule.ref);
    if (own.length === 0) {
      if (rule.scheduled) result.noRows.push(rule.ref);
      continue;
    }
    const produced = new Map(ruleOccurrences(rule.versions, start, to).map((o) => [o.date, o.version.amount]));
    for (const entry of own) {
      const amount = produced.get(entry.dueDate);
      if (amount === undefined) result.missing.push(entry);
      else if (toCents(amount) !== toCents(entry.expected)) result.amounts.push({ entry, ruleRef: rule.ref, ruleAmount: amount });
    }
    const dates = new Set(own.map((entry) => entry.dueDate));
    for (const date of produced.keys()) if (!dates.has(date)) result.extra.push({ ruleRef: rule.ref, date });
  }
  return result;
}
