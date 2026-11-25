import { clampedDay } from "@/features/rules/recurrence";
import { addDays, type IsoDate } from "@/lib/calendar-date";
import type { Cents } from "@/lib/cents";
import type { AccountSeries, ForecastItem } from "./engine";
import type { ComputedOccurrence } from "./occurrences";
import type { PastDay } from "./past";
import { orderedItems } from "./register";

/**
 * The Calendar: a month of one account's days. Pure. Days in the forecast come
 * from the forecast's own days; earlier days, when the page has them, show
 * what was saved and what was due.
 */

/**
 * How a past item stands: the bank shows it paid; the person marked it paid;
 * it was due in an account with bank transactions and none was matched; or
 * (an account kept by hand) it was simply planned.
 */
export type PastState = "bank" | "hand" | "unpaid" | "planned";
export type CalendarItem = ForecastItem & { past?: PastState };
export type CalendarPast = { days: readonly PastDay[]; items: ReadonlyMap<IsoDate, CalendarItem[]> };

export type CalendarDay = {
  date: IsoDate;
  inMonth: boolean;
  today: boolean;
  items: CalendarItem[];
  /** The end-of-day balance, or null for a day with nothing known. */
  closing: Cents | null;
  belowZero: boolean;
  belowCushion: boolean;
};
export type CalendarMonth = { month: string; weeks: CalendarDay[][]; previous: string | null; next: string | null };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const weekday = (date: IsoDate) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Every month ("YYYY-MM") from the series' first day (or `earliest`, when the past is shown) to its last. */
export function seriesMonths(series: AccountSeries, earliest?: IsoDate): string[] {
  const start = earliest !== undefined && earliest < series.days[0].date ? earliest : series.days[0].date;
  const first = start.slice(0, 7);
  const last = series.days[series.days.length - 1].date.slice(0, 7);
  const months: string[] = [];
  for (let month = first; month <= last; month = addDays(`${month}-01`, 32).slice(0, 7)) months.push(month);
  return months;
}

/** The requested month if it is covered; otherwise the month holding today (or the first). */
export function chooseMonth(series: AccountSeries, requested: string | undefined, today: IsoDate, earliest?: IsoDate): string {
  const months = seriesMonths(series, earliest);
  if (requested !== undefined && MONTH.test(requested) && months.includes(requested)) return requested;
  return months.includes(today.slice(0, 7)) ? today.slice(0, 7) : months[0];
}

export function formatMonth(month: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
}

/** What was due in `accountId` before `before`, by the day it landed (its payment's day, once matched). */
export function pastItems(
  occurrences: readonly ComputedOccurrence[],
  accountId: string,
  before: IsoDate,
  /** `bankSince`: the first day the account has bank transactions for; null for one kept by hand. */
  options: { matched: ReadonlySet<string>; bankSince: IsoDate | null },
): Map<IsoDate, CalendarItem[]> {
  const items = new Map<IsoDate, CalendarItem[]>();
  for (const occurrence of occurrences) {
    if (occurrence.status === "SKIPPED" || occurrence.date >= before) continue;
    const share = occurrence.shares.find((s) => s.accountId === accountId && s.cents !== 0n);
    if (!share) continue;
    const past: PastState = options.matched.has(`${occurrence.ruleId}|${occurrence.scheduledOn}`)
      ? "bank"
      : occurrence.status === "PAID"
        ? "hand"
        : options.bankSince !== null && occurrence.date >= options.bankSince
          ? "unpaid"
          : "planned";
    const cents = occurrence.kind === "INCOME" ? share.cents : -share.cents;
    items.set(occurrence.date, [...(items.get(occurrence.date) ?? []), { occurrence, cents, past }]);
  }
  return items;
}

export function calendarMonth(series: AccountSeries, month: string, today: IsoDate, past?: CalendarPast): CalendarMonth {
  const first = `${month}-01`;
  const last = clampedDay(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 31);
  const start = addDays(first, -weekday(first));
  const end = addDays(last, 6 - weekday(last));
  const byDate = new Map(series.days.map((day) => [day.date, day]));
  const pastByDate = new Map((past?.days ?? []).map((day) => [day.date, day]));
  const firstDay = series.days[0].date;

  const weeks: CalendarDay[][] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    if (weekday(date) === 0) weeks.push([]);
    const day = byDate.get(date);
    const before = date < firstDay ? pastByDate.get(date) : undefined;
    const closing = day?.closing ?? before?.closing ?? null;
    weeks[weeks.length - 1].push({
      date,
      inMonth: date.slice(0, 7) === month,
      today: date === today,
      items: day ? orderedItems(day) : date < firstDay ? orderedItems({ items: past?.items.get(date) ?? [] }) : [],
      closing,
      belowZero: day?.belowZero ?? (before !== undefined && before.closing < 0n),
      belowCushion: day?.belowCushion ?? (before !== undefined && series.cushion !== null && before.closing < series.cushion),
    });
  }
  const months = seriesMonths(series, past?.days[0]?.date);
  const index = months.indexOf(month);
  return {
    month,
    weeks,
    previous: index > 0 ? months[index - 1] : null,
    next: index >= 0 && index < months.length - 1 ? months[index + 1] : null,
  };
}
