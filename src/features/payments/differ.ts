import { versionFor } from "@/features/rules/summary";
import type { IsoDate } from "@/lib/calendar-date";
import { toCents, type Cents } from "@/lib/cents";
import { usableTypical, type LayerPayment, type Typical } from "./layer";
import type { MatchRule } from "./match";

/**
 * Fixed bills whose real payments say something else: the planned amount in
 * effect today is more than 2% (and more than a dollar) away from what the
 * recent payments typically were. Pure.
 */

export type Differs = { ruleId: string; ruleName: string; planned: Cents; typical: Typical };

export function differs(planned: Cents, typical: Cents): boolean {
  const gap = planned > typical ? planned - typical : typical - planned;
  return gap > 100n && gap * 100n > planned * 2n;
}

export function paymentsDiffer(rules: readonly MatchRule[], payments: readonly LayerPayment[], today: IsoDate): Differs[] {
  return rules.flatMap((rule) => {
    if (rule.estimateMode !== "FIXED") return [];
    const version = versionFor(rule.versions, today);
    // A rule that has stopped has no future amount to get wrong.
    if (version.effectiveTo !== null && version.effectiveTo < today) return [];
    const typical = usableTypical(rule, payments);
    const planned = toCents(version.amount);
    return typical && differs(planned, typical.cents) ? [{ ruleId: rule.id, ruleName: rule.name, planned, typical }] : [];
  });
}
