import { chartGeometry, type ChartDay } from "@/features/forecast/chart";
import type { Lowest } from "@/features/forecast/engine";
import { formatIsoDate } from "@/features/rules/summary";
import type { Cents } from "@/lib/cents";
import { money } from "./money";

const monthLabel = (date: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

/** One account's forecast, drawn on the server as plain SVG. */
export function BalanceChart({
  name,
  days,
  cushion,
  lowest,
}: {
  name: string;
  days: readonly ChartDay[];
  cushion: Cents | null;
  lowest: Lowest;
}) {
  const geometry = chartGeometry(days, cushion);
  const first = formatIsoDate(days[0].date);
  const last = formatIsoDate(days[days.length - 1].date);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${geometry.width} ${geometry.height}`} role="img" aria-label={`${name}: end-of-day balance, ${first} to ${last}`}>
        {geometry.bands.map((band) => (
          <rect
            key={band.x}
            x={band.x}
            y={0}
            width={band.width}
            height={geometry.height}
            className={band.kind === "below_zero" ? "chart-band-zero" : "chart-band-cushion"}
          />
        ))}
        {geometry.months.map((month) => (
          <g key={month.date}>
            <line x1={month.x} x2={month.x} y1={0} y2={geometry.height} className="chart-month" />
            <text x={month.x + 3} y={14} className="chart-label">
              {monthLabel(month.date)}
            </text>
          </g>
        ))}
        <line x1={0} x2={geometry.width} y1={geometry.zeroY} y2={geometry.zeroY} className="chart-zero" />
        {geometry.cushionY !== null && (
          <line x1={0} x2={geometry.width} y1={geometry.cushionY} y2={geometry.cushionY} className="chart-cushion" />
        )}
        <path d={geometry.path} className="chart-line" />
      </svg>
      <figcaption>
        Lowest {money(lowest.cents)} on {formatIsoDate(lowest.date)}
        {cushion !== null && <> · cushion {money(cushion)}</>} · {first} to {last}
      </figcaption>
    </figure>
  );
}
