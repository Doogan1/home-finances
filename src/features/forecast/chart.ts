import type { IsoDate } from "@/lib/calendar-date";
import type { Cents } from "@/lib/cents";

/**
 * Where to draw one account's forecast: a step line (each day's end-of-day
 * balance held across that day), bands behind days below zero or below the
 * cushion, lines at zero and at the cushion, and a mark where each month
 * starts. The vertical range always includes zero and the cushion. Days marked
 * `past` (always the first ones) are real balances: they get their own line, and
 * `todayX` is where the forecast takes over. Coordinates are ordinary numbers:
 * this is drawing, not money arithmetic.
 */

export type ChartDay = { date: IsoDate; closing: Cents; belowZero: boolean; belowCushion: boolean; past?: boolean };
export type ChartSize = { width: number; height: number; padding: number };
export type ChartBand = { x: number; width: number; kind: "below_zero" | "below_cushion" };
export type ChartGeometry = {
  width: number;
  height: number;
  /** The forecast's step line. */
  path: string;
  /** The same line closed down to the bottom edge, for the fill under it. */
  area: string;
  /** The line through the past days, when there are any. */
  pastPath: string | null;
  /** Where the past ends and the forecast begins; null with no past days. */
  todayX: number | null;
  zeroY: number;
  cushionY: number | null;
  bands: ChartBand[];
  months: { x: number; date: IsoDate }[];
  /** Round amounts across the range, lowest first, for the scale. */
  ticks: { y: number; cents: Cents }[];
  /** The middle of each day at its balance, for pointing at one day. */
  points: { x: number; y: number }[];
  low: Cents;
  high: Cents;
};

export const CHART_SIZE: ChartSize = { width: 640, height: 200, padding: 8 };

const round = (value: number) => Math.round(value * 10) / 10;
const bandKind = (day: ChartDay): ChartBand["kind"] | null =>
  day.belowZero ? "below_zero" : day.belowCushion ? "below_cushion" : null;

const STEPS = [1, 2, 5, 10];

/** Multiples of a round step (1, 2 or 5 times a power of ten) inside [low, high]: up to six of them. */
export function scaleTicks(low: Cents, high: Cents): Cents[] {
  const raw = Number(high - low) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = BigInt(Math.round(magnitude * (STEPS.find((s) => s * magnitude >= raw) ?? 10)));
  if (step <= 0n) return [low, high];
  const ticks: Cents[] = [];
  // The first multiple of the step at or above `low` (bigint division rounds toward zero).
  let tick = (low / step) * step;
  if (tick < low) tick += step;
  for (; tick <= high; tick += step) ticks.push(tick);
  return ticks;
}

export function chartGeometry(days: readonly ChartDay[], cushion: Cents | null, size: ChartSize = CHART_SIZE): ChartGeometry {
  if (days.length === 0) throw new RangeError("A chart needs at least one day");
  const values = [...days.map((d) => d.closing), 0n, ...(cushion === null ? [] : [cushion])];
  const low = values.reduce((a, b) => (b < a ? b : a));
  const top = values.reduce((a, b) => (b > a ? b : a));
  // A flat series still needs a range to draw in.
  const high = top === low ? low + 100n : top;

  const step = (size.width - 2 * size.padding) / days.length;
  const plot = size.height - 2 * size.padding;
  const x = (index: number) => round(size.padding + index * step);
  const y = (cents: Cents) => round(size.padding + (Number(high - cents) / Number(high - low)) * plot);

  const firstForecast = days.findIndex((day) => !day.past);
  const split = firstForecast === -1 ? days.length : firstForecast;
  const line = (from: number, to: number) =>
    days
      .slice(from, to)
      .map((day, k) => (k === 0 ? `M${x(from)} ${y(day.closing)} H${x(from + 1)}` : `V${y(day.closing)} H${x(from + k + 1)}`))
      .join(" ");
  const path = line(split, days.length);
  // The past line runs on to the forecast's first balance, so the two meet.
  const pastPath = split === 0 ? null : split < days.length ? `${line(0, split)} V${y(days[split].closing)}` : line(0, split);

  const bands: ChartBand[] = [];
  let start = 0;
  for (let i = 1; i <= days.length; i++) {
    const kind = bandKind(days[start]);
    if (i < days.length && bandKind(days[i]) === kind) continue;
    if (kind !== null) bands.push({ x: x(start), width: round(x(i) - x(start)), kind });
    start = i;
  }

  return {
    width: size.width,
    height: size.height,
    path,
    area: path === "" ? "" : `${path} V${size.height} H${x(split)} Z`,
    pastPath,
    todayX: split === 0 || split === days.length ? null : x(split),
    zeroY: y(0n),
    cushionY: cushion === null ? null : y(cushion),
    bands,
    months: days.flatMap((day, i) => (day.date.endsWith("-01") ? [{ x: x(i), date: day.date }] : [])),
    ticks: scaleTicks(low, high).map((cents) => ({ y: y(cents), cents })),
    points: days.map((day, i) => ({ x: round(size.padding + (i + 0.5) * step), y: y(day.closing) })),
    low,
    high,
  };
}
