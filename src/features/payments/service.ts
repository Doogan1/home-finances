import "server-only";
import type { PlaidEnvironment, Prisma, PrismaClient } from "@/generated/prisma/client";
import { occurrenceAt } from "@/features/forecast/occurrences";
import { dateOf, lockRule, RuleInputError } from "@/features/rules/service";
import { splitAmount } from "@/features/rules/splits";
import { todayIn, type IsoDate } from "@/lib/calendar-date";
import { toCents } from "@/lib/cents";
import { payeeKey } from "./payee";
import { loadMatchState, matchable } from "./queries";

/**
 * Writes for matching bank transactions to bills and income. A match is a
 * Payment row and nothing else: occurrence edits are never changed, so undoing
 * a match brings back exactly what was there. Every function takes the
 * household id from the caller's session and filters on it.
 */

export type PaymentErrorCode =
  | "transaction_not_found"
  | "already_matched"
  | "not_matched"
  | "rule_not_found"
  | "rule_archived"
  | "wrong_direction"
  | "wrong_account"
  | "occurrence_not_found";

export class PaymentInputError extends Error {
  constructor(readonly code: PaymentErrorCode) {
    super(code);
    this.name = "PaymentInputError";
  }
}

type Scope = { environment: PlaidEnvironment; now?: Date };

/** Another request matched the same transaction first: the unique transaction id refused the second row. */
const isDuplicate = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002";

async function today(db: PrismaClient, householdId: string, now?: Date): Promise<IsoDate | null> {
  const { timeZone } = await db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } });
  return timeZone ? todayIn(timeZone, now) : null;
}

/**
 * Links every transaction the matcher is sure of. Safe to run at any time and
 * any number of times: it only adds payments for transactions that have none,
 * and the unique transaction id stops two runs linking one twice.
 */
export async function runMatching(db: PrismaClient, householdId: string, scope: Scope): Promise<{ linked: number }> {
  const state = await loadMatchState(db, householdId, { environment: scope.environment, today: await today(db, householdId, scope.now) });
  const sure = state.proposals.filter((p) => p.auto);
  if (sure.length === 0) return { linked: 0 };
  const { count } = await db.payment.createMany({
    data: sure.map((p) => ({
      householdId,
      ruleId: p.ruleId,
      transactionId: p.transactionId,
      scheduledOn: p.scheduledOn === null ? null : dateOf(p.scheduledOn),
      source: "AUTO" as const,
    })),
    skipDuplicates: true,
  });
  return { linked: count };
}

/** runMatching for a caller that must not fail because of it (after a sync, after an attach). */
export async function runMatchingQuietly(db: PrismaClient, householdId: string, scope: Scope): Promise<{ linked: number }> {
  try {
    return await runMatching(db, householdId, scope);
  } catch (error) {
    console.error("[payments] matching failed", { name: error instanceof Error ? error.name : typeof error });
    return { linked: 0 };
  }
}

function asPaymentError(error: unknown): never {
  if (error instanceof RuleInputError && (error.code === "rule_not_found" || error.code === "rule_archived")) {
    throw new PaymentInputError(error.code);
  }
  throw error;
}

/**
 * The person says this transaction paid this rule: on `scheduledOn`, or with
 * no due date. The rule must use the transaction's account and go the same
 * way (money out for a bill, in for income).
 */
export async function confirmMatch(
  db: PrismaClient,
  householdId: string,
  userId: string,
  transactionId: string,
  input: { ruleId: string; scheduledOn: IsoDate | null },
  scope: Scope,
): Promise<void> {
  await db
    .$transaction(async (tx) => {
    const rule = await lockRule(tx, householdId, input.ruleId).catch(asPaymentError);
    const transaction = await tx.transaction.findFirst({
      where: { id: transactionId, ...matchable(householdId, scope.environment) },
      select: { id: true, accountId: true, amount: true, payment: { select: { id: true } } },
    });
    if (!transaction) throw new PaymentInputError("transaction_not_found");
    if (transaction.payment) throw new PaymentInputError("already_matched");
    const cents = toCents(transaction.amount.toDecimalPlaces(2).toFixed());
    if (cents === 0n || cents > 0n !== (rule.kind === "BILL")) throw new PaymentInputError("wrong_direction");

    const forecastRule = { id: input.ruleId, name: "", kind: rule.kind, versions: rule.versions };
    if (input.scheduledOn !== null) {
      const occurrence = occurrenceAt(forecastRule, [], input.scheduledOn);
      if (!occurrence) throw new PaymentInputError("occurrence_not_found");
      if (!occurrence.shares.some((s) => s.accountId === transaction.accountId && s.cents > 0n)) throw new PaymentInputError("wrong_account");
    } else {
      const used = rule.versions.some((v) =>
        splitAmount(toCents(v.amount), v.allocations).some((s) => s.accountId === transaction.accountId && s.cents > 0n),
      );
      if (!used) throw new PaymentInputError("wrong_account");
    }

    await tx.matchDecline.deleteMany({ where: { householdId, ruleId: input.ruleId, transactionId } });
    await tx.payment.create({
      data: {
        householdId,
        ruleId: input.ruleId,
        transactionId,
        scheduledOn: input.scheduledOn === null ? null : dateOf(input.scheduledOn),
        source: "PERSON",
        createdByUserId: userId,
      },
    });
    })
    .catch((error: unknown) => {
      if (isDuplicate(error)) throw new PaymentInputError("already_matched");
      throw error;
    });
  // The payee is now known for this rule, so other payments to it may link themselves.
  await runMatchingQuietly(db, householdId, scope);
}

async function decline(tx: Prisma.TransactionClient, householdId: string, ruleId: string, transactionId: string, environment: PlaidEnvironment) {
  const transaction = await tx.transaction.findFirst({
    where: { id: transactionId, account: { householdId, plaidItem: { environment } } },
    select: { merchantName: true, description: true },
  });
  if (!transaction) throw new PaymentInputError("transaction_not_found");
  const key = payeeKey(transaction.merchantName, transaction.description);
  await tx.matchDecline.upsert({
    where: { ruleId_transactionId: { ruleId, transactionId } },
    create: { householdId, ruleId, transactionId, payeeKey: key },
    update: {},
  });
}

/** "No, this is not that bill": the pair is not proposed again, and that payee no longer links itself to the rule. */
export async function declineMatch(db: PrismaClient, householdId: string, transactionId: string, ruleId: string, scope: Scope): Promise<void> {
  await db.$transaction(async (tx) => {
    const rule = await tx.rule.findFirst({ where: { id: ruleId, householdId }, select: { id: true } });
    if (!rule) throw new PaymentInputError("rule_not_found");
    await decline(tx, householdId, ruleId, transactionId, scope.environment);
  });
}

/** Undo a match. The pair is remembered as declined, so the matcher does not put it straight back. */
export async function undoMatch(db: PrismaClient, householdId: string, transactionId: string, scope: Scope): Promise<void> {
  await db.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { transactionId, householdId, transaction: { account: { householdId, plaidItem: { environment: scope.environment } } } },
      select: { id: true, ruleId: true },
    });
    if (!payment) throw new PaymentInputError("not_matched");
    await tx.payment.delete({ where: { id: payment.id } });
    await decline(tx, householdId, payment.ruleId, transactionId, scope.environment);
  });
}
