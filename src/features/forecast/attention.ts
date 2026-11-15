import { addDays, daysBetween, type IsoDate } from "@/lib/calendar-date";
import type { Cents } from "@/lib/cents";
import {
  CLEAR_LOOKBACK_DAYS,
  type AccountSeries,
  type Forecast,
  type ForecastAccount,
  type ForecastInput,
  type Lowest,
} from "./engine";
import { orphanEdits, type ComputedOccurrence, type OrphanEdit } from "./occurrences";

/** What Home calls out, and what is coming up, from a built forecast. Pure. */

export const ESTIMATE_DAYS = 14;
export const STALE_AFTER_DAYS = 7;
export const UPCOMING_DAYS = 7;

export type CashShare = { account: ForecastAccount; cents: Cents };
export type StaleBalance = { account: ForecastAccount; date: IsoDate; days: number };
export type LowBalance = {
  account: ForecastAccount;
  lowest: Lowest;
  firstBelowCushion: IsoDate | null;
  firstBelowZero: IsoDate | null;
  daysBelowCushion: number;
  daysBelowZero: number;
};
export type ClearQuestion = { occurrence: ComputedOccurrence; account: ForecastAccount; snapshotDate: IsoDate; cents: Cents };
export type Attention = {
  needsBalance: ForecastAccount[];
  stale: StaleBalance[];
  low: LowBalance[];
  estimates: ComputedOccurrence[];
  didItClear: ClearQuestion[];
  orphanEdits: OrphanEdit[];
};
export type UpcomingItem = { occurrence: ComputedOccurrence; shares: CashShare[] };

const signed = (occurrence: ComputedOccurrence, cents: Cents) => (occurrence.kind === "INCOME" ? cents : -cents);
const isOpen = (occurrence: ComputedOccurrence) => occurrence.status === "PLANNED" || occurrence.status === "CONFIRMED";
const charted = (forecast: Forecast) => forecast.accounts.filter((a): a is AccountSeries => a.kind === "forecast");
const accountsById = (input: ForecastInput) => new Map(input.accounts.map((a) => [a.id, a]));

/** The shares of an occurrence that land in cash (non-credit) accounts, signed. */
export function cashShares(occurrence: ComputedOccurrence, byId: ReadonlyMap<string, ForecastAccount>): CashShare[] {
  return occurrence.shares.flatMap((share) => {
    const account = byId.get(share.accountId);
    if (!account || account.type === "credit" || share.cents === 0n) return [];
    return [{ account, cents: signed(occurrence, share.cents) }];
  });
}

function lowBalance(series: AccountSeries): LowBalance[] {
  const belowCushion = series.days.filter((d) => d.belowCushion);
  const belowZero = series.days.filter((d) => d.belowZero);
  if (belowCushion.length === 0 && belowZero.length === 0) return [];
  return [
    {
      account: series.account,
      lowest: series.lowest,
      firstBelowCushion: belowCushion[0]?.date ?? null,
      firstBelowZero: belowZero[0]?.date ?? null,
      daysBelowCushion: belowCushion.length,
      daysBelowZero: belowZero.length,
    },
  ];
}

/** Open occurrences dated on or before the account's balance (within 45 days): did the balance include them? */
function clearQuestions(series: AccountSeries, occurrences: readonly ComputedOccurrence[]): ClearQuestion[] {
  const from = addDays(series.snapshot.date, -CLEAR_LOOKBACK_DAYS);
  return occurrences.flatMap((occurrence) => {
    if (!isOpen(occurrence) || occurrence.date < from || occurrence.date > series.snapshot.date) return [];
    const share = occurrence.shares.find((s) => s.accountId === series.account.id && s.cents !== 0n);
    if (!share) return [];
    return [{ occurrence, account: series.account, snapshotDate: series.snapshot.date, cents: signed(occurrence, share.cents) }];
  });
}

export function needsAttention(forecast: Forecast, input: ForecastInput): Attention {
  const byId = accountsById(input);
  const estimatesEnd = addDays(forecast.today, ESTIMATE_DAYS - 1);
  return {
    needsBalance: forecast.accounts.filter((a) => a.kind === "needs_balance").map((a) => a.account),
    stale: charted(forecast).flatMap((series) => {
      const days = daysBetween(series.snapshot.date, forecast.today);
      return days > STALE_AFTER_DAYS ? [{ account: series.account, date: series.snapshot.date, days }] : [];
    }),
    low: charted(forecast).flatMap(lowBalance),
    estimates: forecast.occurrences.filter(
      (o) => o.estimate && isOpen(o) && o.date >= forecast.today && o.date <= estimatesEnd && cashShares(o, byId).length > 0,
    ),
    didItClear: charted(forecast)
      .flatMap((series) => clearQuestions(series, forecast.occurrences))
      .sort(
        (a, b) =>
          a.occurrence.date.localeCompare(b.occurrence.date) ||
          a.account.name.localeCompare(b.account.name) ||
          a.occurrence.ruleName.localeCompare(b.occurrence.ruleName),
      ),
    orphanEdits: orphanEdits(input.rules, input.overrides),
  };
}

export function attentionCount(attention: Attention): number {
  return (
    attention.needsBalance.length +
    attention.stale.length +
    attention.low.length +
    attention.estimates.length +
    attention.didItClear.length +
    attention.orphanEdits.length
  );
}

/** Today and the next `days - 1` days: every occurrence that moves cash, except Skipped ones. */
export function upcoming(forecast: Forecast, input: ForecastInput, days: number = UPCOMING_DAYS): UpcomingItem[] {
  const byId = accountsById(input);
  const end = addDays(forecast.today, days - 1);
  return forecast.occurrences.flatMap((occurrence) => {
    if (occurrence.status === "SKIPPED" || occurrence.date < forecast.today || occurrence.date > end) return [];
    const shares = cashShares(occurrence, byId);
    return shares.length > 0 ? [{ occurrence, shares }] : [];
  });
}
