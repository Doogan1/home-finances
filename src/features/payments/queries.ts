import "server-only";
import type { PlaidEnvironment, Prisma, PrismaClient } from "@/generated/prisma/client";
import { occurrencesBetween, type ForecastOverride } from "@/features/forecast/occurrences";
import { listHouseholdOverrides, listRules, type RuleView } from "@/features/rules/queries";
import { splitAmount } from "@/features/rules/splits";
import { addDays, daysBetween, toIsoDate, type IsoDate } from "@/lib/calendar-date";
import { fromCents, toCents, type Cents } from "@/lib/cents";
import { usableTypical, type LayerPayment } from "./layer";
import { proposeMatches, type MatchRule, type MatchTransaction, type Proposal } from "./match";
import { payeeKey } from "./payee";

/**
 * Reads for matching bank transactions to bills. Every query filters on the
 * session's household and the active Plaid environment. Only posted, live
 * transactions in the person's own accounts (ones with a bank attached) take
 * part: a pending one waits until it posts.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Scope = { environment: PlaidEnvironment };

/** The transactions that can be matched: in an attached account of this household, posted and not removed. */
export const matchable = (householdId: string, environment: PlaidEnvironment) =>
  ({
    removedAt: null,
    pending: false,
    account: { householdId, attachedAt: { not: null }, plaidItem: { environment } },
  }) satisfies Prisma.TransactionWhereInput;

const transactionFields = {
  id: true,
  accountId: true,
  date: true,
  amount: true,
  currency: true,
  description: true,
  merchantName: true,
} satisfies Prisma.TransactionSelect;

type TransactionRow = Prisma.TransactionGetPayload<{ select: typeof transactionFields }>;

export type PaymentView = {
  id: string;
  ruleId: string;
  scheduledOn: IsoDate | null;
  source: "AUTO" | "PERSON";
  transactionId: string;
  accountId: string;
  date: IsoDate;
  /** Unsigned: what was paid, or what arrived. */
  cents: Cents;
  payee: string;
  payeeKey: string;
};

/** A bank amount as a decimal string in whole cents (a stray third decimal is rounded, never an error). */
const decimal = (amount: Prisma.Decimal) => amount.toDecimalPlaces(2).toFixed();

const unsigned = (amount: Prisma.Decimal): Cents => {
  const cents = toCents(decimal(amount));
  return cents < 0n ? -cents : cents;
};

const toMatchTransaction = (row: TransactionRow): MatchTransaction => ({
  id: row.id,
  accountId: row.accountId,
  date: toIsoDate(row.date),
  amount: decimal(row.amount),
  payeeKey: payeeKey(row.merchantName, row.description),
});

/** Every payment of the household whose transaction is still live, oldest first. */
export async function listPayments(db: Db, householdId: string, scope: Scope, ruleId?: string): Promise<PaymentView[]> {
  const rows = await db.payment.findMany({
    where: { householdId, ruleId, transaction: { removedAt: null, account: { householdId, plaidItem: { environment: scope.environment } } } },
    select: { id: true, ruleId: true, scheduledOn: true, source: true, transaction: { select: transactionFields } },
    orderBy: [{ transaction: { date: "asc" } }, { createdAt: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    ruleId: row.ruleId,
    scheduledOn: row.scheduledOn ? toIsoDate(row.scheduledOn) : null,
    source: row.source,
    transactionId: row.transaction.id,
    accountId: row.transaction.accountId,
    date: toIsoDate(row.transaction.date),
    cents: unsigned(row.transaction.amount),
    payee: row.transaction.merchantName ?? row.transaction.description,
    payeeKey: payeeKey(row.transaction.merchantName, row.transaction.description),
  }));
}

export const toLayerPayment = (p: PaymentView): LayerPayment => ({
  ruleId: p.ruleId,
  scheduledOn: p.scheduledOn,
  accountId: p.accountId,
  date: p.date,
  cents: p.cents,
});

const live = (rules: readonly RuleView[]) => rules.filter((r) => r.archivedAt === null);

/** The household's rules as the matcher sees them. A rule that varies carries its typical amount from `today` on. */
export function matchRules(rules: readonly RuleView[], payments: readonly PaymentView[], today: IsoDate | null): MatchRule[] {
  const layer = payments.map(toLayerPayment);
  return live(rules).map((r) => {
    const rule: MatchRule = { id: r.id, name: r.name, kind: r.kind, versions: r.versions, estimateMode: r.estimateMode };
    if (r.estimateMode !== "VARIES" || today === null) return rule;
    const typical = usableTypical(rule, layer);
    return typical ? { ...rule, typical: { amount: fromCents(typical.cents), from: today } } : rule;
  });
}

export type MatchState = {
  rules: MatchRule[];
  overrides: ForecastOverride[];
  payments: PaymentView[];
  proposals: Proposal[];
  /** The unmatched transactions the proposals are about, by id. */
  transactions: Map<string, TransactionRow & { accountName: string }>;
};

/**
 * Everything the matcher needs, and what it proposes. `since` limits which
 * unmatched transactions are looked at (the pages ask about recent ones; a
 * run after a sync looks at all of them).
 */
export async function loadMatchState(
  db: Db,
  householdId: string,
  options: Scope & { today: IsoDate | null; since?: IsoDate },
): Promise<MatchState> {
  const since = options.since === undefined ? undefined : { gte: new Date(`${options.since}T00:00:00.000Z`) };
  const [rules, overrides, payments, declines, unmatched] = await Promise.all([
    listRules(db, householdId),
    listHouseholdOverrides(db, householdId),
    listPayments(db, householdId, options),
    db.matchDecline.findMany({
      where: { householdId, transaction: { account: { householdId, plaidItem: { environment: options.environment } } } },
      select: { ruleId: true, transactionId: true, payeeKey: true },
    }),
    db.transaction.findMany({
      where: { ...matchable(householdId, options.environment), payment: null, date: since },
      select: { ...transactionFields, account: { select: { name: true } } },
      orderBy: [{ date: "asc" }, { id: "asc" }],
    }),
  ]);
  const forMatching = matchRules(rules, payments, options.today);
  const proposals = proposeMatches({
    rules: forMatching,
    overrides,
    payments,
    declines,
    transactions: unmatched.map(toMatchTransaction),
  });
  return {
    rules: forMatching,
    overrides,
    payments,
    proposals,
    transactions: new Map(unmatched.map((row) => [row.id, { ...row, accountName: row.account.name }])),
  };
}

export type MatchQuestion = {
  transactionId: string;
  date: IsoDate;
  payee: string;
  accountName: string;
  /** Unsigned. */
  cents: Cents;
  ruleId: string;
  ruleName: string;
  kind: "INCOME" | "BILL";
  scheduledOn: IsoDate | null;
};

/** "Is this that bill?": what the matcher proposes, newest first. */
export function matchQuestions(state: MatchState): MatchQuestion[] {
  const rules = new Map(state.rules.map((r) => [r.id, r]));
  return state.proposals
    .flatMap((proposal) => {
      const transaction = state.transactions.get(proposal.transactionId);
      const rule = rules.get(proposal.ruleId);
      if (!transaction || !rule) return [];
      return [
        {
          transactionId: transaction.id,
          date: toIsoDate(transaction.date),
          payee: transaction.merchantName ?? transaction.description,
          accountName: transaction.accountName,
          cents: unsigned(transaction.amount),
          ruleId: rule.id,
          ruleName: rule.name,
          kind: rule.kind,
          scheduledOn: proposal.scheduledOn,
        },
      ];
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.ruleName.localeCompare(b.ruleName));
}

/** matchQuestions for recent transactions (those dated `since` or later). */
export async function listMatchQuestions(
  db: Db,
  householdId: string,
  options: Scope & { today: IsoDate; since: IsoDate },
): Promise<MatchQuestion[]> {
  return matchQuestions(await loadMatchState(db, householdId, options));
}

/** How far either side of a transaction's date the person may pick a due date from. */
export const CHOICE_WINDOW_DAYS = 45;

export type TransactionMatch = {
  transaction: {
    id: string;
    date: IsoDate;
    payee: string;
    description: string;
    accountName: string;
    /** As the bank reports it: positive is money leaving. */
    amount: string;
    currency: string;
    pending: boolean;
  };
  /** False for a pending transaction, or one in an account that only comes from a bank. */
  canMatch: boolean;
  payment: { ruleId: string; ruleName: string; scheduledOn: IsoDate | null; source: "AUTO" | "PERSON" } | null;
  /** What the matcher would propose, if anything. */
  suggested: { ruleId: string; scheduledOn: IsoDate | null } | null;
  /** Every rule this transaction could belong to, with the due dates near it. */
  choices: { ruleId: string; name: string; dates: { scheduledOn: IsoDate; date: IsoDate; paid: boolean }[] }[];
};

/** One transaction, with everything its page needs to match it, change its match or undo it. */
export async function loadTransactionMatch(
  db: PrismaClient,
  householdId: string,
  transactionId: string,
  options: Scope & { today: IsoDate | null },
): Promise<TransactionMatch | null> {
  const row = await db.transaction.findFirst({
    where: { id: transactionId, removedAt: null, account: { householdId, plaidItem: { environment: options.environment } } },
    select: {
      ...transactionFields,
      pending: true,
      account: { select: { name: true, attachedAt: true } },
      payment: { select: { ruleId: true, scheduledOn: true, source: true, rule: { select: { name: true } } } },
    },
  });
  if (!row) return null;
  const date = toIsoDate(row.date);
  const canMatch = !row.pending && row.account.attachedAt !== null;
  const transaction = {
    id: row.id,
    date,
    payee: row.merchantName ?? row.description,
    description: row.description,
    accountName: row.account.name,
    amount: decimal(row.amount),
    currency: row.currency,
    pending: row.pending,
  };
  const payment = row.payment && {
    ruleId: row.payment.ruleId,
    ruleName: row.payment.rule.name,
    scheduledOn: row.payment.scheduledOn ? toIsoDate(row.payment.scheduledOn) : null,
    source: row.payment.source,
  };
  if (!canMatch || payment) return { transaction, canMatch, payment, suggested: null, choices: [] };

  const state = await loadMatchState(db, householdId, { ...options, since: date });
  const proposal = state.proposals.find((p) => p.transactionId === row.id);
  const cents = toCents(transaction.amount);
  const kind = cents > 0n ? "BILL" : "INCOME";
  const paid = new Set(state.payments.filter((p) => p.accountId === row.accountId).map((p) => `${p.ruleId}|${p.scheduledOn}`));
  const usesAccount = (shares: { accountId: string; cents: Cents }[]) => shares.some((s) => s.accountId === row.accountId && s.cents > 0n);
  const choices = state.rules
    .filter((rule) => rule.kind === kind && cents !== 0n)
    .flatMap((rule) => {
      const dates = occurrencesBetween(
        [rule],
        state.overrides.filter((o) => o.ruleId === rule.id),
        addDays(date, -CHOICE_WINDOW_DAYS),
        addDays(date, CHOICE_WINDOW_DAYS),
      )
        .filter((o) => usesAccount(o.shares))
        .map((o) => ({ scheduledOn: o.scheduledOn, date: o.date, paid: paid.has(`${rule.id}|${o.scheduledOn}`) }))
        // Nearest first, so the likeliest date is the one already chosen.
        .sort((a, b) => Math.abs(daysBetween(a.date, date)) - Math.abs(daysBetween(b.date, date)) || a.date.localeCompare(b.date));
      const ever = rule.versions.some((v) => usesAccount(splitAmount(toCents(v.amount), v.allocations)));
      return ever ? [{ ruleId: rule.id, name: rule.name, dates }] : [];
    });
  return {
    transaction,
    canMatch,
    payment,
    suggested: proposal ? { ruleId: proposal.ruleId, scheduledOn: proposal.scheduledOn } : null,
    choices,
  };
}
