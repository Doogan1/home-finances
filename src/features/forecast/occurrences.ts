import { ruleOccurrences } from "@/features/rules/recurrence";
import { splitAmount, type Share } from "@/features/rules/splits";
import type { RuleKind, StoredVersion } from "@/features/rules/versions";
import type { IsoDate } from "@/lib/calendar-date";
import { toCents, type Cents } from "@/lib/cents";

/**
 * A rule's occurrences with the person's per-date edits applied. An edit is
 * keyed by the date the rule produced (`scheduledOn`), so it survives a new
 * version; it can confirm the amount, change the status, or move the date.
 * Pure: the forecast, and later the occurrence panel's preview, share it.
 */

export type OccurrenceStatus = "PLANNED" | "CONFIRMED" | "PAID" | "SKIPPED";
export type ForecastRule = {
  id: string;
  name: string;
  kind: RuleKind;
  versions: StoredVersion[];
  /**
   * For a rule whose amount varies: what its recent payments typically were.
   * It stands in for the version's amount on dates scheduled on or after
   * `from` (today), so the past keeps the amounts it had.
   */
  typical?: { amount: string; from: IsoDate };
};
export type ForecastOverride = {
  ruleId: string;
  scheduledOn: IsoDate;
  status: OccurrenceStatus;
  confirmedAmount: string | null;
  movedTo: IsoDate | null;
};

export type ComputedOccurrence = {
  ruleId: string;
  ruleName: string;
  kind: RuleKind;
  versionId: string;
  scheduledOn: IsoDate;
  /** Where it lands: `movedTo` when the person moved it, otherwise `scheduledOn`. */
  date: IsoDate;
  status: OccurrenceStatus;
  /** No amount was confirmed, so the version's amount stands in. */
  estimate: boolean;
  amount: Cents;
  /** Unsigned, in the version's allocation order; they add up to `amount`. */
  shares: Share[];
};

const key = (ruleId: string, scheduledOn: IsoDate) => `${ruleId}|${scheduledOn}`;

/** The one occurrence a rule produces on `date`, if it produces one. */
function producedOn(rule: ForecastRule, date: IsoDate) {
  return ruleOccurrences(rule.versions, date, date)[0] ?? null;
}

/** One scheduled date of a version, with the person's edit (if any) applied. */
function computed(rule: ForecastRule, version: StoredVersion, scheduledOn: IsoDate, e: ForecastOverride | undefined): ComputedOccurrence {
  const confirmed = e?.confirmedAmount ?? null;
  const planned = rule.typical && scheduledOn >= rule.typical.from ? rule.typical.amount : version.amount;
  const amount = toCents(confirmed ?? planned);
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    kind: rule.kind,
    versionId: version.id,
    scheduledOn,
    date: e?.movedTo ?? scheduledOn,
    status: e?.status ?? "PLANNED",
    estimate: confirmed === null,
    amount,
    shares: splitAmount(amount, version.allocations),
  };
}

/** The occurrence a rule produces on `scheduledOn`, with its edit applied; null when the rule does not produce that date. */
export function occurrenceAt(rule: ForecastRule, overrides: readonly ForecastOverride[], scheduledOn: IsoDate): ComputedOccurrence | null {
  const produced = producedOn(rule, scheduledOn);
  if (!produced) return null;
  return computed(rule, produced.version, scheduledOn, overrides.find((o) => o.ruleId === rule.id && o.scheduledOn === scheduledOn));
}

/** Every occurrence whose effective date is in [from, to], Skipped ones included. */
export function occurrencesBetween(
  rules: readonly ForecastRule[],
  overrides: readonly ForecastOverride[],
  from: IsoDate,
  to: IsoDate,
): ComputedOccurrence[] {
  const edits = new Map(overrides.map((o) => [key(o.ruleId, o.scheduledOn), o]));
  const result: ComputedOccurrence[] = [];
  for (const rule of rules) {
    const scheduled = new Map<IsoDate, StoredVersion>();
    for (const { date, version } of ruleOccurrences(rule.versions, from, to)) scheduled.set(date, version);
    // A moved occurrence can land in the range from a scheduled date outside it.
    for (const o of overrides) {
      if (o.ruleId !== rule.id || o.movedTo === null || scheduled.has(o.scheduledOn)) continue;
      const produced = producedOn(rule, o.scheduledOn);
      if (produced) scheduled.set(produced.date, produced.version);
    }
    for (const [scheduledOn, version] of scheduled) {
      const occurrence = computed(rule, version, scheduledOn, edits.get(key(rule.id, scheduledOn)));
      if (occurrence.date < from || occurrence.date > to) continue;
      result.push(occurrence);
    }
  }
  return result.sort(
    (a, b) => a.date.localeCompare(b.date) || a.ruleName.localeCompare(b.ruleName) || a.scheduledOn.localeCompare(b.scheduledOn),
  );
}

export type OrphanEdit = { ruleId: string; ruleName: string; scheduledOn: IsoDate };

/** Edits whose date the rule no longer produces (after a change to it). They are kept, never deleted silently. */
export function orphanEdits(rules: readonly ForecastRule[], overrides: readonly ForecastOverride[]): OrphanEdit[] {
  const byId = new Map(rules.map((r) => [r.id, r]));
  return overrides
    .flatMap((o) => {
      const rule = byId.get(o.ruleId);
      if (!rule || producedOn(rule, o.scheduledOn)) return [];
      return [{ ruleId: rule.id, ruleName: rule.name, scheduledOn: o.scheduledOn }];
    })
    .sort((a, b) => a.scheduledOn.localeCompare(b.scheduledOn) || a.ruleName.localeCompare(b.ruleName));
}
