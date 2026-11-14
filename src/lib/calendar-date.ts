/**
 * Calendar dates ("2026-11-14") with no time of day: due dates, paydays, the
 * date a balance was true. Postgres stores them in `date` columns, which Prisma
 * reads and writes as a Date at UTC midnight, so every conversion here is in UTC.
 * "Today" is the exception: it depends on where the household lives.
 */

export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseIsoDate(value: string): Date | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? date : null;
}

export function toIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (!a || !b) throw new RangeError("daysBetween needs two valid dates");
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** The household's current calendar date. */
export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const TIME_ZONES = new Set(Intl.supportedValuesOf("timeZone"));

/** An IANA time zone name exactly as the runtime lists it. */
export function isTimeZone(value: string): boolean {
  return TIME_ZONES.has(value);
}
