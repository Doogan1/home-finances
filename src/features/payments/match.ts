import { occurrencesBetween, type ComputedOccurrence, type ForecastOverride, type ForecastRule } from "@/features/forecast/occurrences";
import { splitAmount } from "@/features/rules/splits";
import { addDays, daysBetween, type IsoDate } from "@/lib/calendar-date";
import { toCents, type Cents } from "@/lib/cents";
import { sharesWord } from "./payee";

/**
 * Which bank transactions look like which bills. Pure: the service decides
 * what to save. A proposal is `auto` only when the payee was already confirmed
 * for that one rule and the fit is clear; everything else is a question for
 * the person.
 *
 * Amounts arrive as the bank reports them: positive is money leaving.
 */

/** How far a payment may be from its due date, either way. */
export const MATCH_WINDOW_DAYS = 10;
/** Without a known payee or a shared word, only this close a date (and an amount within 1%) is worth asking about. */
const AMOUNT_ONLY_DAYS = 3;

export type EstimateMode = "FIXED" | "VARIES";
export type MatchRule = ForecastRule & { estimateMode: EstimateMode };
export type MatchTransaction = { id: string; accountId: string; date: IsoDate; amount: string; payeeKey: string };
/** A payment that already exists: it marks its occurrence paid for its account, and teaches the rule its payee. */
export type KnownPayment = { ruleId: string; scheduledOn: IsoDate | null; accountId: string; payeeKey: string };
export type Declined = { ruleId: string; transactionId: string; payeeKey: string };

export type MatchInput = {
  rules: readonly MatchRule[];
  /** The person's own edits (not layered with payments): Skipped dates and moves count. */
  overrides: readonly ForecastOverride[];
  payments: readonly KnownPayment[];
  declines: readonly Declined[];
  /** Posted transactions with no payment yet. */
  transactions: readonly MatchTransaction[];
};

export type Proposal = {
  transactionId: string;
  ruleId: string;
  /** The due date it would pay; null for a payment from before the rule's first date. */
  scheduledOn: IsoDate | null;
  auto: boolean;
};

type Candidate = Proposal & { known: boolean; score: number };

const paidKey = (ruleId: string, scheduledOn: IsoDate, accountId: string) => `${ruleId}|${scheduledOn}|${accountId}`;
const payeeOf = (ruleId: string, key: string) => `${ruleId}|${key}`;

/** `cents` is within `percent`% of `expected`. */
const within = (cents: Cents, expected: Cents, percent: bigint) => {
  const gap = cents > expected ? cents - expected : expected - cents;
  return gap * 100n <= expected * percent;
};

/** Close enough to link without asking: a quarter either way for a fixed amount, half to double for one that varies. */
function plausible(cents: Cents, expected: Cents, mode: EstimateMode): boolean {
  if (expected <= 0n) return false;
  return mode === "FIXED" ? within(cents, expected, 25n) : cents * 2n >= expected && cents <= expected * 2n;
}

function shareIn(occurrence: ComputedOccurrence, accountId: string): Cents {
  return occurrence.shares.find((s) => s.accountId === accountId)?.cents ?? 0n;
}

/** The share of the rule's first version that lands in `accountId`, for a transaction from before the rule began. */
function historyShare(rule: MatchRule, transaction: MatchTransaction): Cents {
  const first = [...rule.versions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
  if (!first || transaction.date >= first.effectiveFrom) return 0n;
  return splitAmount(toCents(first.amount), first.allocations).find((s) => s.accountId === transaction.accountId)?.cents ?? 0n;
}

const versionShares = new WeakMap<object, Map<string, Cents>>();

/** What each version of the rule puts in (or takes from) `accountId`, worked out once per version. */
function plannedShares(rule: MatchRule, accountId: string): Cents[] {
  return rule.versions.map((version) => {
    let shares = versionShares.get(version);
    if (!shares) {
      shares = new Map(splitAmount(toCents(version.amount), version.allocations).map((s) => [s.accountId, s.cents]));
      versionShares.set(version, shares);
    }
    return shares.get(accountId) ?? 0n;
  });
}

/** A cheap test before any dates are worked out: could this amount be worth asking about with no payee to go on? */
function amountRings(rule: MatchRule, accountId: string, cents: Cents, overrides: readonly ForecastOverride[]): boolean {
  if (plannedShares(rule, accountId).some((share) => share > 0n && within(cents, share, 1n))) return true;
  if (rule.typical && within(cents, toCents(rule.typical.amount), 1n)) return true;
  return overrides.some((o) => o.ruleId === rule.id && o.confirmedAmount !== null && within(cents, toCents(o.confirmedAmount), 1n));
}

function candidateFor(
  rule: MatchRule,
  transaction: MatchTransaction,
  cents: Cents,
  input: MatchInput,
  paid: ReadonlySet<string>,
  knownPayees: ReadonlySet<string>,
  declinedPayees: ReadonlySet<string>,
): Candidate | null {
  const known = knownPayees.has(payeeOf(rule.id, transaction.payeeKey));
  const word = sharesWord(rule.name, transaction.payeeKey);
  if (!known && !word && !amountRings(rule, transaction.accountId, cents, input.overrides)) return null;

  const open = occurrencesBetween(
    [rule],
    input.overrides.filter((o) => o.ruleId === rule.id),
    addDays(transaction.date, -MATCH_WINDOW_DAYS),
    addDays(transaction.date, MATCH_WINDOW_DAYS),
  )
    .filter(
      (o) => o.status !== "SKIPPED" && shareIn(o, transaction.accountId) > 0n && !paid.has(paidKey(rule.id, o.scheduledOn, transaction.accountId)),
    )
    .map((occurrence) => ({ occurrence, distance: Math.abs(daysBetween(occurrence.date, transaction.date)) }))
    .sort((a, b) => a.distance - b.distance || a.occurrence.date.localeCompare(b.occurrence.date));

  const nearest = open[0];
  const expected = nearest ? shareIn(nearest.occurrence, transaction.accountId) : historyShare(rule, transaction);
  if (expected <= 0n) return null;

  const exact = within(cents, expected, 1n);
  const distance = nearest?.distance ?? MATCH_WINDOW_DAYS;
  if (!known && !word && !(nearest && exact && distance <= AMOUNT_ONLY_DAYS)) return null;

  const ambiguous = open.length > 1 && open[1].distance === distance;
  const auto =
    known && !declinedPayees.has(payeeOf(rule.id, transaction.payeeKey)) && !ambiguous && plausible(cents, expected, rule.estimateMode);
  const score =
    (known ? 100 : 0) + (word ? 40 : 0) + (exact ? 30 : within(cents, expected, 10n) ? 15 : within(cents, expected, 25n) ? 5 : 0) + (MATCH_WINDOW_DAYS - distance);
  return { transactionId: transaction.id, ruleId: rule.id, scheduledOn: nearest?.occurrence.scheduledOn ?? null, auto, known, score };
}

/**
 * At most one proposal per transaction. Transactions are taken oldest first,
 * and an automatic match takes its occurrence, so a second payment to the same
 * payee goes to the next due date rather than the same one.
 */
export function proposeMatches(input: MatchInput): Proposal[] {
  const paid = new Set(input.payments.flatMap((p) => (p.scheduledOn === null ? [] : [paidKey(p.ruleId, p.scheduledOn, p.accountId)])));
  const knownPayees = new Set(input.payments.map((p) => payeeOf(p.ruleId, p.payeeKey)));
  const declinedPayees = new Set(input.declines.map((d) => payeeOf(d.ruleId, d.payeeKey)));
  const declinedPairs = new Set(input.declines.map((d) => `${d.ruleId}|${d.transactionId}`));

  const proposals: Proposal[] = [];
  const ordered = [...input.transactions].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const transaction of ordered) {
    const amount = toCents(transaction.amount);
    if (amount === 0n) continue;
    const kind = amount > 0n ? "BILL" : "INCOME";
    const cents = amount > 0n ? amount : -amount;
    const candidates = input.rules.flatMap((rule) => {
      if (rule.kind !== kind || declinedPairs.has(`${rule.id}|${transaction.id}`)) return [];
      const candidate = candidateFor(rule, transaction, cents, input, paid, knownPayees, declinedPayees);
      return candidate ? [candidate] : [];
    });
    if (candidates.length === 0) continue;

    // Linked without asking only when exactly one rule knows this payee.
    const known = candidates.filter((c) => c.known);
    const best = known.length === 1 && known[0].auto ? known[0] : [...candidates].sort((a, b) => b.score - a.score || a.ruleId.localeCompare(b.ruleId))[0];
    const auto = known.length === 1 && best === known[0] && best.auto;
    proposals.push({ transactionId: best.transactionId, ruleId: best.ruleId, scheduledOn: best.scheduledOn, auto });
    if (auto && best.scheduledOn !== null) paid.add(paidKey(best.ruleId, best.scheduledOn, transaction.accountId));
  }
  return proposals;
}
