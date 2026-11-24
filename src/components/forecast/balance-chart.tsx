import { CHART_SIZE, chartGeometry, type ChartDay } from "@/features/forecast/chart";
import type { Lowest } from "@/features/forecast/engine";
import { formatIsoDate } from "@/features/rules/summary";
import type { Cents } from "@/lib/cents";
import { money } from "./money";

const monthLabel = (date: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

/**
 * One account's forecast, drawn on the server. The SVG stretches to its box
 * (lines keep their width); text is HTML over it, so it is not stretched.
 */
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
  const { width, height } = geometry;
  const first = formatIsoDate(days[0].date);
  const last = formatIsoDate(days[days.length - 1].date);
  return (
    <figure className="chart">
      <div className={geometry.months.length > 6 ? "chart-plot chart-months-many" : "chart-plot"}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${name}: end-of-day balance, ${first} to ${last}`}
        >
          <path d={`${geometry.path} V${height} H${CHART_SIZE.padding} Z`} className="chart-area" />
          {geometry.bands.map((band) => (
            <rect
              key={band.x}
              x={band.x}
              y={0}
              width={band.width}
              height={height}
              className={band.kind === "below_zero" ? "chart-band-zero" : "chart-band-cushion"}
            />
          ))}
          {geometry.months.map((month) => (
            <line key={month.date} x1={month.x} x2={month.x} y1={0} y2={height} className="chart-month" />
          ))}
          <line x1={0} x2={width} y1={geometry.zeroY} y2={geometry.zeroY} className="chart-zero" />
          {geometry.cushionY !== null && (
            <line x1={0} x2={width} y1={geometry.cushionY} y2={geometry.cushionY} className="chart-cushion" />
          )}
          <path d={geometry.path} className="chart-line" />
        </svg>
        {geometry.months.map((month) => (
          <span key={month.date} className="chart-label" style={{ left: `${(month.x / width) * 100}%` }} aria-hidden="true">
            {monthLabel(month.date)}
          </span>
        ))}
      </div>
      <figcaption>
        Lowest {money(lowest.cents)} on {formatIsoDate(lowest.date)}
        {cushion !== null && <> · cushion {money(cushion)}</>} · {first} to {last}
      </figcaption>
    </figure>
  );
}
