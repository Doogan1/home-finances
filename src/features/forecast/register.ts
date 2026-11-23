import type { IsoDate } from "@/lib/calendar-date";
import type { Cents } from "@/lib/cents";
import type { AccountSeries, ForecastDay, ForecastItem } from "./engine";
import type { ComputedOccurrence } from "./occurrences";

/**
 * The Register: one account's items in order, each with the balance after it,
 * like a checkbook. Pure, from the forecast's own days, so it always agrees
 * with Home and the Calendar.
 */

export type RegisterRow = {
  date: IsoDate;
  occurrence: ComputedOccurrence;
  cents: Cents;
  balance: Cents;
  belowZero: boolean;
  belowCushion: boolean;
};

/** A day's items with income first, so a payday never shows a dip that does not happen. */
export function orderedItems(day: ForecastDay): ForecastItem[] {
  const rank = (item: ForecastItem) => (item.occurrence.kind === "INCOME" ? 0 : 1);
  return [...day.items].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.occurrence.ruleName.localeCompare(b.occurrence.ruleName) ||
      a.occurrence.scheduledOn.localeCompare(b.occurrence.scheduledOn),
  );
}

export function registerRows(series: AccountSeries): RegisterRow[] {
  return series.days.flatMap((day) => {
    let balance = day.opening;
    return orderedItems(day).map((item) => {
      balance += item.cents;
      return {
        date: day.date,
        occurrence: item.occurrence,
        cents: item.cents,
        balance,
        belowZero: day.belowZero,
        belowCushion: day.belowCushion,
      };
    });
  });
}
