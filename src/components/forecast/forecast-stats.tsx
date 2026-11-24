import type { AccountSeries } from "@/features/forecast/engine";
import { formatIsoDate } from "@/features/rules/summary";
import type { IsoDate } from "@/lib/calendar-date";
import { money } from "./money";

/** The two figures Home leads with: where the account ends today, and its lowest point ahead. */
export function ForecastStats({ series, today }: { series: AccountSeries; today: IsoDate }) {
  const { lowest, cushion } = series;
  const day = series.days.find((d) => d.date === today);
  const tone = lowest.cents < 0n ? "stat-negative" : cushion !== null && lowest.cents < cushion ? "stat-low" : undefined;
  return (
    <dl className="stats">
      {day && (
        <div className="stat-lead">
          <dt>{series.account.name}, end of today</dt>
          <dd>{money(day.closing)}</dd>
        </div>
      )}
      <div className={tone}>
        <dt>Lowest, {formatIsoDate(lowest.date)}</dt>
        <dd>{money(lowest.cents)}</dd>
      </div>
    </dl>
  );
}
