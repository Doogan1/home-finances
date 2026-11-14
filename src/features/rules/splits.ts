import { percentOf, toCents, type Cents } from "@/lib/cents";

/**
 * How one occurrence's amount is divided across accounts. Percentages are
 * rounded half up to the cent, fixed amounts are taken as given, and the one
 * REMAINDER gets what is left, so the shares always add up to the amount.
 */

export type AllocationMode = "PERCENT" | "FIXED" | "REMAINDER";
export type AllocationLike = { accountId: string; mode: AllocationMode; value: string | null };
export type Share = { accountId: string; cents: Cents };

export class SplitError extends Error {
  constructor(readonly code: "needs_one_remainder" | "over_allocated") {
    super(code);
    this.name = "SplitError";
  }
}

function fixedShare(allocation: AllocationLike, amount: Cents): Cents {
  if (allocation.value === null) throw new RangeError(`A ${allocation.mode} allocation needs a value`);
  return allocation.mode === "PERCENT" ? percentOf(amount, allocation.value) : toCents(allocation.value);
}

export function splitAmount(amount: Cents, allocations: readonly AllocationLike[]): Share[] {
  if (allocations.filter((a) => a.mode === "REMAINDER").length !== 1) throw new SplitError("needs_one_remainder");
  const shares = allocations.map((a) => ({ accountId: a.accountId, cents: a.mode === "REMAINDER" ? 0n : fixedShare(a, amount) }));
  const rest = amount - shares.reduce((sum, share) => sum + share.cents, 0n);
  if (rest < 0n) throw new SplitError("over_allocated");
  return shares.map((share, i) => (allocations[i].mode === "REMAINDER" ? { ...share, cents: rest } : share));
}
