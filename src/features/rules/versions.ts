import { addDays, type IsoDate } from "@/lib/calendar-date";
import { toCents, type Cents } from "@/lib/cents";
import { clampedDay, firstOnOrAfter, nextOccurrences, type DatedPattern, type Pattern } from "./recurrence";
import { SplitError, splitAmount, type AllocationLike, type Share } from "./splits";
import { latestVersion } from "./summary";

/**
 * The rules about versions that need no database: what a schedule and a split
 * must satisfy, and what "Change from…", "Stop on…" and "Edit this version"
 * would write. Pure, so the service and the forms' previews agree exactly.
 */

export type RuleErrorCode =
  | "rule_not_found"
  | "version_not_found"
  | "rule_archived"
  | "account_not_found"
  | "account_archived"
  | "account_linked"
  | "income_to_credit"
  | "bill_needs_one_account"
  | "needs_one_remainder"
  | "over_allocated"
  | "pays_account_invalid"
  | "anchor_not_on_day"
  | "anchor_before_start"
  | "change_not_after_start"
  | "rule_ended"
  | "no_later_occurrence"
  | "stop_before_version_start"
  | "end_before_start"
  | "only_latest_version_can_end"
  | "occurrence_not_found"
  | "confirmed_needs_amount"
  | "move_out_of_range"
  | "question_not_found";

/** How far one occurrence can be moved from the date the rule gave it, either way. */
export const MAX_MOVE_DAYS = 62;

export type RuleKind = "INCOME" | "BILL";
export type VersionDraft = Pattern & { amount: string; note: string | null; allocations: AllocationLike[] };
export type StoredVersion = VersionDraft & DatedPattern & { id: string };
export type Planned<T> = { ok: true; value: T } | { ok: false; code: RuleErrorCode };

const refuse = (code: RuleErrorCode): { ok: false; code: RuleErrorCode } => ({ ok: false, code });

export function scheduleProblem(pattern: Pattern, effectiveFrom: IsoDate): RuleErrorCode | null {
  if (pattern.anchorDate < effectiveFrom) return "anchor_before_start";
  if (pattern.recurrence === "MONTHLY" && pattern.dayOfMonth !== null) {
    const year = Number(pattern.anchorDate.slice(0, 4));
    const month = Number(pattern.anchorDate.slice(5, 7));
    if (clampedDay(year, month, pattern.dayOfMonth) !== pattern.anchorDate) return "anchor_not_on_day";
  }
  return null;
}

function splitOrCode(amount: string, allocations: readonly AllocationLike[]): Share[] | RuleErrorCode {
  try {
    return splitAmount(toCents(amount), allocations);
  } catch (error) {
    if (error instanceof SplitError) return error.code;
    throw error;
  }
}

export function allocationProblem(
  kind: RuleKind,
  amount: string,
  allocations: readonly (AllocationLike & { accountType: string })[],
): RuleErrorCode | null {
  if (kind === "BILL" && (allocations.length !== 1 || allocations[0].mode !== "REMAINDER")) return "bill_needs_one_account";
  if (kind === "INCOME" && allocations.some((a) => a.accountType === "credit")) return "income_to_credit";
  const shares = splitOrCode(amount, allocations);
  return typeof shares === "string" ? shares : null;
}

export type ChangeFrom = { from: IsoDate; amount: string; note: string | null; allocations: AllocationLike[]; schedule: Pattern | null };
export type NewVersion = VersionDraft & { effectiveFrom: IsoDate; effectiveTo: IsoDate | null };

const patternOf = (v: Pattern): Pattern => ({
  recurrence: v.recurrence,
  interval: v.interval,
  anchorDate: v.anchorDate,
  dayOfMonth: v.dayOfMonth,
  secondDay: v.secondDay,
});

/**
 * Change from date D: the latest version ends on D − 1 and a copy with the
 * edits starts on D. Unless the schedule itself changes, the copy keeps the
 * old pattern, anchored on its first date on or after D.
 */
export function planChangeFrom(
  versions: readonly StoredVersion[],
  change: ChangeFrom,
): Planned<{ endVersionId: string; endOn: IsoDate; next: NewVersion }> {
  const current = latestVersion(versions);
  if (change.from <= current.effectiveFrom) return refuse("change_not_after_start");
  if (current.effectiveTo !== null && change.from > current.effectiveTo) return refuse("rule_ended");

  let schedule = change.schedule;
  if (schedule === null) {
    const anchorDate = firstOnOrAfter(current, change.from);
    if (anchorDate === null) return refuse("no_later_occurrence");
    if (current.effectiveTo !== null && anchorDate > current.effectiveTo) return refuse("no_later_occurrence");
    schedule = { ...patternOf(current), anchorDate };
  }
  const problem = scheduleProblem(schedule, change.from);
  if (problem) return refuse(problem);

  return {
    ok: true,
    value: {
      endVersionId: current.id,
      endOn: addDays(change.from, -1),
      next: {
        ...patternOf(schedule),
        effectiveFrom: change.from,
        effectiveTo: current.effectiveTo,
        amount: change.amount,
        note: change.note,
        allocations: change.allocations,
      },
    },
  };
}

/** Stop on date D: the latest version's last possible day becomes D. */
export function planStop(versions: readonly StoredVersion[], on: IsoDate): Planned<{ versionId: string; effectiveTo: IsoDate }> {
  const current = latestVersion(versions);
  if (on < current.effectiveFrom) return refuse("stop_before_version_start");
  // Moving or removing a stop is done through "Edit this version".
  if (current.effectiveTo !== null && on > current.effectiveTo) return refuse("rule_ended");
  return { ok: true, value: { versionId: current.id, effectiveTo: on } };
}

export type VersionEdit = VersionDraft & { effectiveTo?: IsoDate | null };

/** Edit this version, in place. Only the latest version's end date may change (that is how a stop is undone). */
export function planEdit(
  versions: readonly StoredVersion[],
  versionId: string,
  edit: VersionEdit,
): Planned<{ effectiveTo: IsoDate | null }> {
  const version = versions.find((v) => v.id === versionId);
  if (!version) return refuse("version_not_found");
  let effectiveTo = version.effectiveTo;
  if (edit.effectiveTo !== undefined && edit.effectiveTo !== version.effectiveTo) {
    if (version.id !== latestVersion(versions).id) return refuse("only_latest_version_can_end");
    effectiveTo = edit.effectiveTo;
  }
  if (effectiveTo !== null && effectiveTo < version.effectiveFrom) return refuse("end_before_start");
  const problem = scheduleProblem(edit, version.effectiveFrom);
  if (problem) return refuse(problem);
  return { ok: true, value: { effectiveTo } };
}

export type ChangePreview = {
  endOn: IsoDate;
  next: { date: IsoDate; amount: string }[];
  perAccount: { accountId: string; change: Cents }[];
};

const shareOf = (shares: readonly Share[], accountId: string) => shares.find((s) => s.accountId === accountId)?.cents ?? 0n;

/** What "Change from…" would do, for the form: the end date, the next dates, and each account's change per occurrence. */
export function previewChange(versions: readonly StoredVersion[], change: ChangeFrom, count = 3): Planned<ChangePreview> {
  const plan = planChangeFrom(versions, change);
  if (!plan.ok) return plan;
  const current = latestVersion(versions);
  const before = splitOrCode(current.amount, current.allocations);
  const after = splitOrCode(change.amount, change.allocations);
  if (typeof before === "string") return refuse(before);
  if (typeof after === "string") return refuse(after);

  const accountIds = [...new Set([...before, ...after].map((s) => s.accountId))];
  const perAccount = accountIds
    .map((accountId) => ({ accountId, change: shareOf(after, accountId) - shareOf(before, accountId) }))
    .filter((p) => p.change !== 0n);
  const next = nextOccurrences([plan.value.next], change.from, count).map((o) => ({ date: o.date, amount: change.amount }));
  return { ok: true, value: { endOn: plan.value.endOn, next, perAccount } };
}
