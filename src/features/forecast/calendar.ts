import { clampedDay } from "@/features/rules/recurrence";
import { addDays, type IsoDate } from "@/lib/calendar-date";
import type { Cents } from "@/lib/cents";
import type { AccountSeries, ForecastItem } from "./engine";
import { orderedItems } from "./register";

/** The Calendar: a month of one account's days. Pure, from the forecast's own days. */

export type CalendarDay = {
  date: IsoDate;
  inMonth: boolean;
  today: boolean;
  items: ForecastItem[];
  /** The end-of-day balance, or null for a day outside the forecast. */
  closing: Cents | null;
  belowZero: boolean;
  belowCushion: boolean;
};
export type CalendarMonth = { month: string; weeks: CalendarDay[][]; previous: string | null; next: string | null };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const weekday = (date: IsoDate) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Every month ("YYYY-MM") from the series' first day to its last. */
export function seriesMonths(series: AccountSeries): string[] {
  const first = series.days[0].date.slice(0, 7);
  const last = series.days[series.days.length - 1].date.slice(0, 7);
  const months: string[] = [];
  for (let month = first; month <= last; month = addDays(`${month}-01`, 32).slice(0, 7)) months.push(month);
  return months;
}

/** The requested month if the forecast covers it; otherwise the month holding today (or the first). */
export function chooseMonth(series: AccountSeries, requested: string | undefined, today: IsoDate): string {
  const months = seriesMonths(series);
  if (requested !== undefined && MONTH.test(requested) && months.includes(requested)) return requested;
  return months.includes(today.slice(0, 7)) ? today.slice(0, 7) : months[0];
}

export function formatMonth(month: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
}

export function calendarMonth(series: AccountSeries, month: string, today: IsoDate): CalendarMonth {
  const first = `${month}-01`;
  const last = clampedDay(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 31);
  const start = addDays(first, -weekday(first));
  const end = addDays(last, 6 - weekday(last));
  const byDate = new Map(series.days.map((day) => [day.date, day]));

  const weeks: CalendarDay[][] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    if (weekday(date) === 0) weeks.push([]);
    const day = byDate.get(date);
    weeks[weeks.length - 1].push({
      date,
      inMonth: date.slice(0, 7) === month,
      today: date === today,
      items: day ? orderedItems(day) : [],
      closing: day?.closing ?? null,
      belowZero: day?.belowZero ?? false,
      belowCushion: day?.belowCushion ?? false,
    });
  }
  const months = seriesMonths(series);
  const index = months.indexOf(month);
  return {
    month,
    weeks,
    previous: index > 0 ? months[index - 1] : null,
    next: index >= 0 && index < months.length - 1 ? months[index + 1] : null,
  };
}
