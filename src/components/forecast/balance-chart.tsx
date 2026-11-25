import { CHART_SIZE, chartGeometry, type ChartDay } from "@/features/forecast/chart";
import type { ForecastItem, Lowest } from "@/features/forecast/engine";
import { formatIsoDate } from "@/features/rules/summary";
import type { IsoDate } from "@/lib/calendar-date";
import type { Cents } from "@/lib/cents";
import { ChartPicker, type PickerDay } from "./chart-picker";
import { compactMoney, money, signedMoney } from "./money";

const monthLabel = (date: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

/** A forecast day brings its items; a past day brings `notes`, already worded. */
export type ChartedDay = ChartDay & { items?: readonly ForecastItem[]; notes?: readonly string[] };

/**
 * One account's balance, drawn on the server: real balances before today (when
 * the page has them), then the forecast. The SVG stretches to its box (lines
 * keep their width); the scale, the month names and the day read-out are HTML
 * around and over it, so they are not stretched.
 */
export function BalanceChart({
  name,
  days,
  cushion,
  lowest,
  today,
}: {
  name: string;
  days: readonly ChartedDay[];
  cushion: Cents | null;
  lowest: Lowest;
  today: IsoDate;
}) {
  const geometry = chartGeometry(days, cushion);
  const { width, height } = geometry;
  const first = formatIsoDate(days[0].date);
  const last = formatIsoDate(days[days.length - 1].date);
  const across = (x: number) => (x / width) * 100;
  const down = (y: number) => (y / height) * 100;
  const pickerDays: PickerDay[] = days.map((day, i) => ({
    date: formatIsoDate(day.date),
    balance: money(day.closing),
    items: day.notes ? [...day.notes] : (day.items ?? []).map((item) => `${item.occurrence.ruleName} ${signedMoney(item.cents)}`),
    left: across(geometry.points[i].x),
    top: down(geometry.points[i].y),
    past: day.past === true,
  }));
  const todayIndex = days.findIndex((day) => day.date === today);
  return (
    <figure className="chart">
      <div className="chart-frame">
        <div className="chart-axis" aria-hidden="true">
          {geometry.ticks.map((tick) => (
            <span key={String(tick.cents)} style={{ top: `${down(tick.y)}%` }}>
              {compactMoney(tick.cents)}
            </span>
          ))}
        </div>
        <div className={geometry.months.length > 6 ? "chart-plot chart-months-many" : "chart-plot"}>
          <ChartPicker days={pickerDays} start={Math.max(todayIndex, 0)} edge={CHART_SIZE.padding / width}>
            <svg
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${name}: end-of-day balance, ${first} to ${last}`}
            >
              {geometry.area !== "" && <path d={geometry.area} className="chart-area" />}
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
              {geometry.ticks.map((tick) => (
                <line key={String(tick.cents)} x1={0} x2={width} y1={tick.y} y2={tick.y} className="chart-grid" />
              ))}
              {geometry.months.map((month) => (
                <line key={month.date} x1={month.x} x2={month.x} y1={0} y2={height} className="chart-month" />
              ))}
              <line x1={0} x2={width} y1={geometry.zeroY} y2={geometry.zeroY} className="chart-zero" />
              {geometry.cushionY !== null && (
                <line x1={0} x2={width} y1={geometry.cushionY} y2={geometry.cushionY} className="chart-cushion" />
              )}
              {geometry.todayX !== null && (
                <line x1={geometry.todayX} x2={geometry.todayX} y1={0} y2={height} className="chart-today" />
              )}
              {geometry.pastPath !== null && <path d={geometry.pastPath} className="chart-line chart-line-past" />}
              {geometry.path !== "" && <path d={geometry.path} className="chart-line" />}
            </svg>
          </ChartPicker>
          {geometry.months.map((month) => (
            <span key={month.date} className="chart-label" style={{ left: `${across(month.x)}%` }} aria-hidden="true">
              {monthLabel(month.date)}
            </span>
          ))}
        </div>
      </div>
      <figcaption>
        Lowest {money(lowest.cents)} on {formatIsoDate(lowest.date)}
        {cushion !== null && <> · cushion {money(cushion)}</>} · {first} to {last}
        {geometry.todayX !== null && <> · grey is what happened, green from the dashed line is the forecast</>}
      </figcaption>
    </figure>
  );
}
