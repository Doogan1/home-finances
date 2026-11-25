import { occurrenceAt, type ForecastOverride, type ForecastRule } from "@/features/forecast/occurrences";
import { splitAmount, SplitError, type AllocationLike } from "@/features/rules/splits";
import { versionFor } from "@/features/rules/summary";
import type { IsoDate } from "@/lib/calendar-date";
import { fromCents, toCents, type Cents } from "@/lib/cents";

/**
 * Payments over the person's edits. A matched bank transaction never changes
 * an occurrence edit; instead the forecast reads the edits with payments laid
 * over them, so undoing a match brings back exactly what was there. Pure.
 */

/** One matched transaction: which occurrence it pays (or none), from which account, when, and how much (unsigned). */
export type LayerPayment = { ruleId: string; scheduledOn: IsoDate | null; accountId: string; date: IsoDate; cents: Cents };

const sum = (payments: readonly LayerPayment[]) => payments.reduce((total, p) => total + p.cents, 0n);
const latest = (payments: readonly LayerPayment[]) => payments.reduce((max, p) => (p.date > max ? p.date : max), payments[0].date);

function divides(total: Cents, allocations: readonly AllocationLike[]): boolean {
  try {
    splitAmount(total, allocations);
    return true;
  } catch (error) {
    if (error instanceof SplitError) return false;
    throw error;
  }
}

/** True when the payments reach every account the amount is split across. */
function covers(payments: readonly LayerPayment[], amount: string, allocations: readonly AllocationLike[]): boolean {
  const paid = new Set(payments.map((p) => p.accountId));
  return splitAmount(toCents(amount), allocations).every((share) => share.cents === 0n || paid.has(share.accountId));
}

function grouped(payments: readonly LayerPayment[], key: (p: LayerPayment) => string): LayerPayment[][] {
  const groups = new Map<string, LayerPayment[]>();
  for (const payment of payments) groups.set(key(payment), [...(groups.get(key(payment)) ?? []), payment]);
  return [...groups.values()];
}

/**
 * The edits the forecast should read. An occurrence whose payments reach every
 * account it is split across is Paid on its latest payment's date, and its
 * amount becomes the payments' sum when the splits can divide that sum. Until
 * then (one deposit of a split paycheck has arrived, the other has not) nothing
 * changes: an occurrence has one date for all its accounts, so marking it paid
 * early would drop the share still to come. Payments for a date the rule does
 * not produce, or with no due date, change nothing here.
 */
export function layerPayments(
  rules: readonly ForecastRule[],
  overrides: readonly ForecastOverride[],
  payments: readonly LayerPayment[],
): ForecastOverride[] {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const result = new Map(overrides.map((o) => [`${o.ruleId}|${o.scheduledOn}`, o]));
  for (const group of grouped(payments.filter((p) => p.scheduledOn !== null), (p) => `${p.ruleId}|${p.scheduledOn}`)) {
    const { ruleId } = group[0];
    const scheduledOn = group[0].scheduledOn as IsoDate;
    const rule = byId.get(ruleId);
    const occurrence = rule && occurrenceAt(rule, overrides, scheduledOn);
    const version = occurrence && rule.versions.find((v) => v.id === occurrence.versionId);
    if (!occurrence || !version) continue;
    const key = `${ruleId}|${scheduledOn}`;
    const base = result.get(key) ?? { ruleId, scheduledOn, status: "PLANNED" as const, confirmedAmount: null, movedTo: null };
    if (!covers(group, fromCents(occurrence.amount), version.allocations)) continue;
    const total = sum(group);
    const paidOn = latest(group);
    result.set(key, {
      ...base,
      status: "PAID",
      confirmedAmount: divides(total, version.allocations) ? fromCents(total) : base.confirmedAmount,
      movedTo: paidOn === scheduledOn ? null : paidOn,
    });
  }
  return [...result.values()];
}

/** True when the payments for `scheduledOn` make the forecast read it as Paid (see layerPayments). */
export function paidInFull(rule: ForecastRule, overrides: readonly ForecastOverride[], payments: readonly LayerPayment[], scheduledOn: IsoDate): boolean {
  const group = payments.filter((p) => p.ruleId === rule.id && p.scheduledOn === scheduledOn);
  const occurrence = group.length > 0 ? occurrenceAt(rule, overrides, scheduledOn) : null;
  const version = occurrence && rule.versions.find((v) => v.id === occurrence.versionId);
  return !!occurrence && !!version && covers(group, fromCents(occurrence.amount), version.allocations);
}

export type PaymentTotal = { date: IsoDate; cents: Cents };

/**
 * What a rule was really paid each time, oldest first: one total per due date
 * (per day, for payments with no due date), counting only the times the
 * payments reached every account the rule splits across.
 */
export function paymentTotals(rule: ForecastRule, payments: readonly LayerPayment[]): PaymentTotal[] {
  const own = payments.filter((p) => p.ruleId === rule.id);
  return grouped(own, (p) => p.scheduledOn ?? `on ${p.date}`)
    .flatMap((group) => {
      const version = versionFor(rule.versions, group[0].scheduledOn ?? group[0].date);
      return covers(group, version.amount, version.allocations) ? [{ date: latest(group), cents: sum(group) }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const TYPICAL_OF = 6;
export const TYPICAL_NEEDS = 3;

export type Typical = { cents: Cents; count: number; low: Cents; high: Cents };

/** The median of the last six totals (half up to the cent), once there are at least three. */
export function typicalAmount(totals: readonly PaymentTotal[]): Typical | null {
  const recent = totals.slice(-TYPICAL_OF).map((t) => t.cents).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (recent.length < TYPICAL_NEEDS) return null;
  const middle = recent.length >> 1;
  const cents = recent.length % 2 === 1 ? recent[middle] : (recent[middle - 1] + recent[middle] + 1n) / 2n;
  return { cents, count: recent.length, low: recent[0], high: recent[recent.length - 1] };
}

/** The typical amount when the rule's latest version can split it; otherwise nothing. */
export function usableTypical(rule: ForecastRule, payments: readonly LayerPayment[]): Typical | null {
  const typical = typicalAmount(paymentTotals(rule, payments));
  if (!typical) return null;
  return rule.versions.every((version) => divides(typical.cents, version.allocations)) ? typical : null;
}
