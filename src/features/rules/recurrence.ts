import { addDays, daysBetween, type IsoDate } from "@/lib/calendar-date";

/**
 * The dates a rule produces, computed whenever they are needed (nothing is
 * stored, so nothing needs regenerating). Pure and synchronous: pages, forms
 * and the forecast all compute the same dates from the same code.
 */

export type Recurrence = "ONCE" | "WEEKLY" | "MONTHLY" | "TWICE_MONTHLY";

export type Pattern = {
  recurrence: Recurrence;
  interval: number;
  anchorDate: IsoDate;
  dayOfMonth: number | null;
  secondDay: number | null;
};

export type DatedPattern = Pattern & { effectiveFrom: IsoDate; effectiveTo: IsoDate | null };

export type Occurrence<V> = { date: IsoDate; version: V };

/** Longer than the longest gap a pattern can have (24 months). */
const SEARCH_DAYS = 800;

const pad = (value: number, width = 2) => String(value).padStart(width, "0");
const iso = (year: number, month: number, day: number): IsoDate => `${pad(year, 4)}-${pad(month)}-${pad(day)}`;

/** Months counted from year 0, so consecutive months differ by one. */
const monthIndex = (date: IsoDate) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
const fromMonthIndex = (index: number) => ({ year: Math.floor(index / 12), month: (index % 12) + 1 });

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `day` of the month, or the month's last day when the month is shorter. */
export function clampedDay(year: number, month: number, day: number): IsoDate {
  return iso(year, month, Math.min(day, daysInMonth(year, month)));
}

function need(value: number | null, what: string): number {
  if (value === null) throw new RangeError(`This schedule needs ${what}`);
  return value;
}

/** Every date the pattern produces in [from, to], in order. Nothing before the anchor. */
export function patternDates(pattern: Pattern, from: IsoDate, to: IsoDate): IsoDate[] {
  const start = from > pattern.anchorDate ? from : pattern.anchorDate;
  if (start > to) return [];
  const dates: IsoDate[] = [];
  switch (pattern.recurrence) {
    case "ONCE":
      // start is never before the anchor, so the anchor counts only when it is the start.
      if (pattern.anchorDate === start) dates.push(start);
      break;
    case "WEEKLY": {
      const step = 7 * pattern.interval;
      const skip = Math.ceil(daysBetween(pattern.anchorDate, start) / step);
      for (let date = addDays(pattern.anchorDate, skip * step); date <= to; date = addDays(date, step)) dates.push(date);
      break;
    }
    case "MONTHLY": {
      const day = need(pattern.dayOfMonth, "a day of the month");
      const anchor = monthIndex(pattern.anchorDate);
      for (let k = Math.floor((monthIndex(start) - anchor) / pattern.interval); ; k++) {
        const { year, month } = fromMonthIndex(anchor + k * pattern.interval);
        const date = clampedDay(year, month, day);
        if (date > to) break;
        if (date >= start) dates.push(date);
      }
      break;
    }
    case "TWICE_MONTHLY": {
      const days = [need(pattern.dayOfMonth, "a first day"), need(pattern.secondDay, "a second day")];
      for (let index = monthIndex(start); ; index++) {
        const { year, month } = fromMonthIndex(index);
        if (iso(year, month, 1) > to) break;
        for (const day of days) {
          const date = clampedDay(year, month, day);
          if (date >= start && date <= to) dates.push(date);
        }
      }
      break;
    }
  }
  return dates;
}

/** The dates a version produces inside both its own range and [from, to]. */
export function versionDates(version: DatedPattern, from: IsoDate, to: IsoDate): IsoDate[] {
  const low = from > version.effectiveFrom ? from : version.effectiveFrom;
  const high = version.effectiveTo !== null && version.effectiveTo < to ? version.effectiveTo : to;
  return low > high ? [] : patternDates(version, low, high);
}

/** A rule's occurrences across its versions (which never overlap), in date order. */
export function ruleOccurrences<V extends DatedPattern>(versions: readonly V[], from: IsoDate, to: IsoDate): Occurrence<V>[] {
  return versions
    .flatMap((version) => versionDates(version, from, to).map((date) => ({ date, version })))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** The first `count` occurrences on or after `from`, looking up to five years ahead. */
export function nextOccurrences<V extends DatedPattern>(versions: readonly V[], from: IsoDate, count: number): Occurrence<V>[] {
  return ruleOccurrences(versions, from, addDays(from, 5 * 366)).slice(0, count);
}

/** The first date the pattern produces on or after `date`, or null if there is none. */
export function firstOnOrAfter(pattern: Pattern, date: IsoDate): IsoDate | null {
  return patternDates(pattern, date, addDays(date, SEARCH_DAYS))[0] ?? null;
}
