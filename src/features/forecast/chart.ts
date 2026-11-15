import type { IsoDate } from "@/lib/calendar-date";
import type { Cents } from "@/lib/cents";

/**
 * Where to draw one account's forecast: a step line (each day's end-of-day
 * balance held across that day), bands behind days below zero or below the
 * cushion, lines at zero and at the cushion, and a mark where each month
 * starts. The vertical range always includes zero and the cushion. Coordinates
 * are ordinary numbers: this is drawing, not money arithmetic.
 */

export type ChartDay = { date: IsoDate; closing: Cents; belowZero: boolean; belowCushion: boolean };
export type ChartSize = { width: number; height: number; padding: number };
export type ChartBand = { x: number; width: number; kind: "below_zero" | "below_cushion" };
export type ChartGeometry = {
  width: number;
  height: number;
  path: string;
  zeroY: number;
  cushionY: number | null;
  bands: ChartBand[];
  months: { x: number; date: IsoDate }[];
  low: Cents;
  high: Cents;
};

export const CHART_SIZE: ChartSize = { width: 640, height: 200, padding: 8 };

const round = (value: number) => Math.round(value * 10) / 10;
const bandKind = (day: ChartDay): ChartBand["kind"] | null =>
  day.belowZero ? "below_zero" : day.belowCushion ? "below_cushion" : null;

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

  const path = days
    .map((day, i) => (i === 0 ? `M${x(0)} ${y(day.closing)} H${x(1)}` : `V${y(day.closing)} H${x(i + 1)}`))
    .join(" ");

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
    zeroY: y(0n),
    cushionY: cushion === null ? null : y(cushion),
    bands,
    months: days.flatMap((day, i) => (day.date.endsWith("-01") ? [{ x: x(i), date: day.date }] : [])),
    low,
    high,
  };
}
