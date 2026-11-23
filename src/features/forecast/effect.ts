import type { IsoDate } from "@/lib/calendar-date";
import { buildForecast, type AccountSeries, type ForecastInput, type Lowest } from "./engine";
import { occurrenceAt, type ForecastOverride, type ForecastRule, type OccurrenceStatus } from "./occurrences";

/**
 * What a draft edit of one occurrence would do to the forecast: each affected
 * account's lowest point before and after. Pure, and run in the browser by the
 * occurrence panel, so the preview is the same engine as every balance shown.
 */

export type EditFields = { status: OccurrenceStatus; confirmedAmount: string | null; movedTo: IsoDate | null };
export type Effect = { accountId: string; accountName: string; before: Lowest; after: Lowest };

/** The input with this occurrence's edit replaced by `edit` (or removed, when `edit` is null). */
export function withEdit(input: ForecastInput, ruleId: string, scheduledOn: IsoDate, edit: EditFields | null): ForecastInput {
  const others = input.overrides.filter((o) => !(o.ruleId === ruleId && o.scheduledOn === scheduledOn));
  const overrides: ForecastOverride[] = edit === null ? others : [...others, { ruleId, scheduledOn, ...edit }];
  return { ...input, overrides };
}

function touched(rule: ForecastRule, overrides: readonly ForecastOverride[], scheduledOn: IsoDate): string[] {
  const occurrence = occurrenceAt(rule, overrides, scheduledOn);
  return occurrence ? occurrence.shares.filter((s) => s.cents !== 0n).map((s) => s.accountId) : [];
}

const seriesById = (input: ForecastInput) =>
  new Map(
    buildForecast(input)
      .accounts.filter((a): a is AccountSeries => a.kind === "forecast")
      .map((a) => [a.account.id, a]),
  );

export function editEffect(input: ForecastInput, ruleId: string, scheduledOn: IsoDate, edit: EditFields | null): Effect[] {
  const rule = input.rules.find((r) => r.id === ruleId);
  if (!rule) return [];
  const edited = withEdit(input, ruleId, scheduledOn, edit);
  const accounts = new Set([...touched(rule, input.overrides, scheduledOn), ...touched(rule, edited.overrides, scheduledOn)]);
  const before = seriesById(input);
  const after = seriesById(edited);
  return [...before.values()].flatMap((series) => {
    const changed = after.get(series.account.id);
    if (!accounts.has(series.account.id) || !changed) return [];
    return [{ accountId: series.account.id, accountName: series.account.name, before: series.lowest, after: changed.lowest }];
  });
}
