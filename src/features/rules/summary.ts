import { formatMoney } from "@/features/plaid/format";
import type { IsoDate } from "@/lib/calendar-date";
import { fromCents, toCents, type Cents } from "@/lib/cents";
import type { DatedPattern, Pattern } from "./recurrence";
import type { AllocationLike } from "./splits";

/** How rules read on screen, and which list each belongs in. Pure display logic. */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function formatIsoDate(date: IsoDate): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

export function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  const suffix: Record<number, string> = { 1: "st", 2: "nd", 3: "rd" };
  return `${n}${suffix[n % 10] ?? "th"}`;
}

/** 31 is how a schedule says "the last day of the month". */
function dayName(day: number | null): string {
  if (day === null) return "";
  return day === 31 ? "last day" : ordinal(day);
}

export function describeSchedule(pattern: Pattern): string {
  switch (pattern.recurrence) {
    case "ONCE":
      return `Once, ${formatIsoDate(pattern.anchorDate)}`;
    case "WEEKLY": {
      const weekday = WEEKDAYS[new Date(`${pattern.anchorDate}T00:00:00Z`).getUTCDay()];
      return pattern.interval === 1 ? `Every ${weekday}` : `Every ${pattern.interval} weeks, ${weekday}`;
    }
    case "MONTHLY": {
      const day = dayName(pattern.dayOfMonth);
      return pattern.interval === 1 ? `Monthly, ${day}` : `Every ${pattern.interval} months, ${day}`;
    }
    case "TWICE_MONTHLY":
      return `${dayName(pattern.dayOfMonth)} and ${dayName(pattern.secondDay)}`;
  }
}

/** a ÷ b rounded half up, for positive values. */
const divideHalfUp = (a: bigint, b: bigint) => (2n * a + b) / (2n * b);

/** About how much a month: weekly × 52 ÷ 12, every N months ÷ N, twice a month × 2; none for a one-off. */
export function monthlyEquivalent(amount: Cents, pattern: Pick<Pattern, "recurrence" | "interval">): Cents | null {
  const interval = BigInt(pattern.interval);
  switch (pattern.recurrence) {
    case "ONCE":
      return null;
    case "WEEKLY":
      return divideHalfUp(amount * 52n, 12n * interval);
    case "MONTHLY":
      return divideHalfUp(amount, interval);
    case "TWICE_MONTHLY":
      return amount * 2n;
  }
}

export type NamedAllocation = AllocationLike & { accountName: string };

/** "70.0000" → "70", "12.50" → "12.5". */
const plainNumber = (value: string) => (value.includes(".") ? value.replace(/\.?0+$/, "") : value);

function describeShare(allocation: NamedAllocation): string {
  switch (allocation.mode) {
    case "PERCENT":
      return `${plainNumber(allocation.value ?? "")}% ${allocation.accountName}`;
    case "FIXED":
      return `${formatMoney(fromCents(toCents(allocation.value ?? "0")), "USD")} ${allocation.accountName}`;
    case "REMAINDER":
      return `rest ${allocation.accountName}`;
  }
}

export function describeAllocations(allocations: readonly NamedAllocation[]): string {
  if (allocations.length === 1) return allocations[0].accountName;
  const ordered = [...allocations.filter((a) => a.mode !== "REMAINDER"), ...allocations.filter((a) => a.mode === "REMAINDER")];
  return ordered.map(describeShare).join(" · ");
}

const byStart = (a: DatedPattern, b: DatedPattern) => a.effectiveFrom.localeCompare(b.effectiveFrom);

export function latestVersion<V extends DatedPattern>(versions: readonly V[]): V {
  const sorted = [...versions].sort(byStart);
  const latest = sorted[sorted.length - 1];
  if (!latest) throw new RangeError("A rule always has at least one version");
  return latest;
}

/** The version in effect on `date`; else the next one to start; else the latest. */
export function versionFor<V extends DatedPattern>(versions: readonly V[], date: IsoDate): V {
  const sorted = [...versions].sort(byStart);
  return (
    sorted.find((v) => v.effectiveFrom <= date && (v.effectiveTo === null || v.effectiveTo >= date)) ??
    sorted.find((v) => v.effectiveFrom > date) ??
    latestVersion(sorted)
  );
}

export type RuleState = "active" | "ended" | "archived";

export function ruleState(rule: { archivedAt: Date | null; versions: readonly DatedPattern[] }, today: IsoDate): RuleState {
  if (rule.archivedAt) return "archived";
  const { effectiveTo } = latestVersion(rule.versions);
  return effectiveTo !== null && effectiveTo < today ? "ended" : "active";
}

export type RuleGroup = "income" | "checking" | "cards";

/** Bills paid from a card are shown separately: the card payment, not the bill, moves cash. */
export function ruleGroup(kind: "INCOME" | "BILL", accountTypes: readonly string[]): RuleGroup {
  if (kind === "INCOME") return "income";
  return accountTypes.includes("credit") ? "cards" : "checking";
}
