import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { parseIsoDate, todayIn } from "@/lib/calendar-date";
import { acceptsManualBalances, isHandManaged } from "./linking";
import { ACCOUNT_KINDS, type CreateAccountInput, type RecordBalancesInput, type UpdateAccountInput } from "./input";

/**
 * Writes for hand-entered accounts and balances. Every function takes the
 * household id from the caller's session and filters on it, so an id from the
 * browser can only ever reach this household's rows. Accounts that only came
 * from a bank keep their Plaid-owned fields: they cannot be renamed, archived or
 * given manual balances here. An attached account (src/features/accounts/linking.ts)
 * can be renamed, and takes manual balances once its bank is disconnected.
 */

export type AccountErrorCode =
  | "account_not_found"
  | "not_manual"
  | "archived"
  | "time_zone_required"
  | "future_date"
  | "in_use"
  // Attaching a bank account (src/features/accounts/attach.ts):
  | "already_linked"
  | "bank_account_not_found"
  | "not_plaid"
  | "already_attached"
  | "connection_disconnected"
  | "kind_mismatch"
  | "not_reported"
  | "bank_account_in_use";

export class AccountInputError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    // For "in_use" and "bank_account_in_use": the rules that use the account.
    readonly ruleNames: readonly string[] = [],
  ) {
    super(code);
    this.name = "AccountInputError";
  }
}

/** The app's client, or a transaction the caller holds (the workbook import writes everything in one). */
type Writer = PrismaClient | Prisma.TransactionClient;

export async function createManualAccount(
  db: Writer,
  householdId: string,
  input: CreateAccountInput,
  // Set only by the workbook import: the workbook's Account ID.
  options: { importRef?: string } = {},
) {
  const kind = ACCOUNT_KINDS[input.kind];
  return db.account.create({
    data: {
      householdId,
      name: input.name,
      type: kind.type,
      subtype: kind.subtype,
      currency: "USD",
      ownerLabel: input.ownerLabel,
      cushion: input.cushion,
      includeInForecast: kind.type !== "credit",
      importRef: options.importRef ?? null,
    },
    select: { id: true },
  });
}

async function findOwned(db: PrismaClient, householdId: string, accountId: string) {
  const account = await db.account.findFirst({
    where: { id: accountId, householdId },
    select: { id: true, plaidItemId: true, attachedAt: true, archivedAt: true },
  });
  if (!account) throw new AccountInputError("account_not_found");
  return account;
}

export async function updateAccount(db: PrismaClient, householdId: string, accountId: string, input: UpdateAccountInput) {
  const account = await findOwned(db, householdId, accountId);
  if (account.archivedAt) throw new AccountInputError("archived");
  // A bank-only account keeps its bank's name; an attached one is the person's own.
  if (input.name !== undefined && !isHandManaged(account)) throw new AccountInputError("not_manual");
  await db.account.update({
    where: { id: account.id },
    data: {
      name: input.name,
      ownerLabel: input.ownerLabel,
      cushion: input.cushion,
      includeInForecast: input.includeInForecast,
    },
  });
}

export async function archiveManualAccount(db: PrismaClient, householdId: string, accountId: string, now: Date = new Date()) {
  const account = await findOwned(db, householdId, accountId);
  if (account.plaidItemId !== null) throw new AccountInputError("not_manual");

  // A rule still uses the account if a version that splits money to or from it
  // has no end, or ends today or later. Without a time zone there is no
  // "today", so every such version counts.
  const household = await db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } });
  const today = household.timeZone ? parseIsoDate(todayIn(household.timeZone, now)) : null;
  const stillRunning = today ? { OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] } : {};
  const users = await db.rule.findMany({
    where: { householdId, archivedAt: null, versions: { some: { ...stillRunning, allocations: { some: { accountId: account.id } } } } },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  if (users.length > 0) throw new AccountInputError("in_use", users.map((rule) => rule.name));

  // Guarded so archiving twice keeps the first date.
  // plaidItemId: null keeps this from racing an attach that links the account after the check above.
  const archived = await db.account.updateMany({
    where: { id: account.id, archivedAt: null, plaidItemId: null },
    data: { archivedAt: new Date() },
  });
  if (archived.count === 0) {
    const current = await findOwned(db, householdId, accountId);
    if (current.plaidItemId !== null) throw new AccountInputError("not_manual");
  }
}

export async function setHouseholdTimeZone(db: PrismaClient, householdId: string, timeZone: string) {
  await db.household.update({ where: { id: householdId }, data: { timeZone } });
}

export async function recordBalances(
  db: PrismaClient,
  householdId: string,
  input: RecordBalancesInput,
  now: Date = new Date(),
) {
  return db.$transaction((tx) => recordBalancesIn(tx, householdId, input, now));
}

/** recordBalances inside a transaction the caller holds. */
export async function recordBalancesIn(
  tx: Prisma.TransactionClient,
  householdId: string,
  input: RecordBalancesInput,
  now: Date = new Date(),
) {
  const household = await tx.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } });
  if (!household.timeZone) throw new AccountInputError("time_zone_required");
  // ISO dates compare correctly as strings.
  if (input.asOfDate > todayIn(household.timeZone, now)) throw new AccountInputError("future_date");
  const asOfDate = parseIsoDate(input.asOfDate);
  if (!asOfDate) throw new AccountInputError("future_date");

  const ids = input.entries.map((entry) => entry.accountId);
  const accounts = await tx.account.findMany({
    where: { id: { in: ids }, householdId },
    select: { id: true, plaidItemId: true, attachedAt: true, archivedAt: true, currency: true, plaidItem: { select: { status: true } } },
  });
  if (accounts.length !== ids.length) throw new AccountInputError("account_not_found");
  // Balances from a connected bank are never typed over; an attached account
  // takes typed balances again once its bank is disconnected.
  if (accounts.some((a) => !acceptsManualBalances({ ...a, connectionStatus: a.plaidItem?.status ?? null }))) {
    throw new AccountInputError("not_manual");
  }
  if (accounts.some((a) => a.archivedAt !== null)) throw new AccountInputError("archived");

  const currency = new Map(accounts.map((a) => [a.id, a.currency]));
  await tx.balanceSnapshot.createMany({
    data: input.entries.map((entry) => ({
      accountId: entry.accountId,
      observedAt: now,
      asOfDate,
      current: entry.balance,
      currency: currency.get(entry.accountId) ?? "USD",
      source: "MANUAL" as const,
      note: input.note,
    })),
  });
  return { recorded: input.entries.length };
}
