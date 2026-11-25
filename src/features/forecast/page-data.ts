import "server-only";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import { todayIn, type IsoDate } from "@/lib/calendar-date";
import { getDb } from "@/lib/db";
import { buildForecast, type AccountSeries, type Forecast, type ForecastInput } from "./engine";
import type { PastDay } from "./past";
import { loadAccountPast } from "./past-queries";
import { loadForecastInput } from "./queries";

/** What Home, the Register, the Calendar and the occurrence panel all start from, so they show the same numbers. */
export type HouseholdForecast =
  | { ready: false }
  | { ready: true; today: IsoDate; timeZone: string; input: ForecastInput; forecast: Forecast; charted: AccountSeries[] };

export async function loadHouseholdForecast(householdId: string): Promise<HouseholdForecast> {
  const db = getDb();
  const { timeZone } = await db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } });
  if (!timeZone) return { ready: false };
  const today = todayIn(timeZone);
  const input = await loadForecastInput(db, householdId, { environment: getPlaidEnvironment(), timeZone, today });
  const forecast = buildForecast(input);
  const charted = forecast.accounts.filter((a): a is AccountSeries => a.kind === "forecast");
  return { ready: true, today, timeZone, input, forecast, charted };
}

/** The chosen account's days before its forecast begins, as far back as `days`. */
export function loadPast(householdId: string, data: Extract<HouseholdForecast, { ready: true }>, series: AccountSeries, days: number): Promise<PastDay[]> {
  return loadAccountPast(getDb(), householdId, series, { environment: getPlaidEnvironment(), timeZone: data.timeZone, days });
}

/** The account named in the address bar, only if it is one of this household's own; otherwise the first. */
export function chooseSeries(charted: readonly AccountSeries[], requested: string | undefined): AccountSeries | null {
  return charted.find((a) => a.account.id === requested) ?? charted[0] ?? null;
}
