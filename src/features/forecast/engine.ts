import { addDays, type IsoDate } from "@/lib/calendar-date";
import { toCents, type Cents } from "@/lib/cents";
import { occurrencesBetween, type ComputedOccurrence, type ForecastOverride, type ForecastRule } from "./occurrences";
import type { LatestSnapshot } from "./snapshots";

/**
 * The cash-flow forecast: each cash account's end-of-day balance from its
 * latest balance to the end of the window. A pure function of its input (no
 * database, no clock), so every screen that shows a balance shows the same one.
 *
 * - An account starts from its latest balance, true at the end of that date.
 * - An occurrence counts for an account when its effective date is after that
 *   account's balance date and it is not Skipped. Paid ones count too: Paid
 *   means the money has left, and the balance predates it.
 * - Income adds each account's share; a bill subtracts it. Items on one day net out.
 * - Credit accounts are never forecast, so a bill paid from a card moves no cash.
 */

export const FORECAST_DAYS = 90;
/** "Did it clear?" looks this far back from an account's latest balance. */
export const CLEAR_LOOKBACK_DAYS = 45;

export type ForecastAccount = {
  id: string;
  name: string;
  type: string;
  subtype: string | null;
  includeInForecast: boolean;
  cushion: string | null;
  archived: boolean;
  /** False once the bank stops reporting the account. Always true for hand-entered ones. */
  active: boolean;
};

export type ForecastInput = {
  today: IsoDate;
  days: number;
  accounts: readonly ForecastAccount[];
  /** Each account's latest balance, by account id. */
  snapshots: ReadonlyMap<string, LatestSnapshot>;
  /** Rules that are not archived. */
  rules: readonly ForecastRule[];
  overrides: readonly ForecastOverride[];
};

export type ForecastItem = { occurrence: ComputedOccurrence; cents: Cents };
export type ForecastDay = {
  date: IsoDate;
  opening: Cents;
  items: ForecastItem[];
  closing: Cents;
  belowZero: boolean;
  belowCushion: boolean;
};
export type Lowest = { date: IsoDate; cents: Cents };
export type NeedsBalance = { kind: "needs_balance"; account: ForecastAccount };
export type AccountSeries = {
  kind: "forecast";
  account: ForecastAccount;
  snapshot: LatestSnapshot;
  cushion: Cents | null;
  days: ForecastDay[];
  lowest: Lowest;
};
export type AccountForecast = NeedsBalance | AccountSeries;
export type Forecast = { today: IsoDate; end: IsoDate; accounts: AccountForecast[]; occurrences: ComputedOccurrence[] };

export function isForecastAccount(account: ForecastAccount): boolean {
  return account.type !== "credit" && account.includeInForecast && !account.archived && account.active;
}

const rank = (account: ForecastAccount) => (account.cushion !== null ? 0 : account.subtype === "checking" ? 1 : 2);

/** Accounts with a cushion first (the one the household watches), then checking, then by name. */
export function compareAccounts(a: ForecastAccount, b: ForecastAccount): number {
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

function accountSeries(
  account: ForecastAccount,
  snapshot: LatestSnapshot,
  occurrences: readonly ComputedOccurrence[],
  today: IsoDate,
  end: IsoDate,
): AccountSeries {
  const cushion = account.cushion === null ? null : toCents(account.cushion);
  const byDate = new Map<IsoDate, ForecastItem[]>();
  for (const occurrence of occurrences) {
    if (occurrence.status === "SKIPPED" || occurrence.date <= snapshot.date || occurrence.date > end) continue;
    for (const share of occurrence.shares) {
      if (share.accountId !== account.id || share.cents === 0n) continue;
      const cents = occurrence.kind === "INCOME" ? share.cents : -share.cents;
      byDate.set(occurrence.date, [...(byDate.get(occurrence.date) ?? []), { occurrence, cents }]);
    }
  }

  const dayAfter = addDays(snapshot.date, 1);
  const start = dayAfter < today ? dayAfter : today;
  const days: ForecastDay[] = [];
  let balance = toCents(snapshot.balance);
  let lowest: Lowest | null = null;
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const items = byDate.get(date) ?? [];
    const opening = balance;
    balance = items.reduce((sum, item) => sum + item.cents, opening);
    days.push({
      date,
      opening,
      items,
      closing: balance,
      belowZero: balance < 0n,
      belowCushion: cushion !== null && balance < cushion,
    });
    if (lowest === null || balance < lowest.cents) lowest = { date, cents: balance };
  }
  // The window always includes today, so there is at least one day.
  if (lowest === null) throw new RangeError("A forecast needs at least one day");
  return { kind: "forecast", account, snapshot, cushion, days, lowest };
}

export function buildForecast(input: ForecastInput): Forecast {
  const end = addDays(input.today, input.days - 1);
  const accounts = input.accounts.filter(isForecastAccount).sort(compareAccounts);
  // Far enough back for every account's "Did it clear?" questions.
  const earliest = accounts.reduce((min, a) => {
    const date = input.snapshots.get(a.id)?.date;
    return date !== undefined && date < min ? date : min;
  }, input.today);
  const occurrences = occurrencesBetween(input.rules, input.overrides, addDays(earliest, -CLEAR_LOOKBACK_DAYS), end);
  return {
    today: input.today,
    end,
    occurrences,
    accounts: accounts.map((account): AccountForecast => {
      const snapshot = input.snapshots.get(account.id);
      return snapshot ? accountSeries(account, snapshot, occurrences, input.today, end) : { kind: "needs_balance", account };
    }),
  };
}
