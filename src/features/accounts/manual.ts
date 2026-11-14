import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { parseIsoDate, todayIn } from "@/lib/calendar-date";
import { ACCOUNT_KINDS, type CreateAccountInput, type RecordBalancesInput, type UpdateAccountInput } from "./input";

/**
 * Writes for hand-entered accounts and balances. Every function takes the
 * household id from the caller's session and filters on it, so an id from the
 * browser can only ever reach this household's rows. Plaid-linked accounts
 * keep their Plaid-owned fields: they cannot be renamed, archived or given
 * manual balances here.
 */

export type AccountErrorCode = "account_not_found" | "not_manual" | "archived" | "time_zone_required" | "future_date";

export class AccountInputError extends Error {
  constructor(readonly code: AccountErrorCode) {
    super(code);
    this.name = "AccountInputError";
  }
}

export async function createManualAccount(db: PrismaClient, householdId: string, input: CreateAccountInput) {
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
    },
    select: { id: true },
  });
}

async function findOwned(db: PrismaClient, householdId: string, accountId: string) {
  const account = await db.account.findFirst({
    where: { id: accountId, householdId },
    select: { id: true, plaidItemId: true, archivedAt: true },
  });
  if (!account) throw new AccountInputError("account_not_found");
  return account;
}

export async function updateAccount(db: PrismaClient, householdId: string, accountId: string, input: UpdateAccountInput) {
  const account = await findOwned(db, householdId, accountId);
  if (account.archivedAt) throw new AccountInputError("archived");
  if (input.name !== undefined && account.plaidItemId !== null) throw new AccountInputError("not_manual");
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

export async function archiveManualAccount(db: PrismaClient, householdId: string, accountId: string) {
  const account = await findOwned(db, householdId, accountId);
  if (account.plaidItemId !== null) throw new AccountInputError("not_manual");
  // Guarded so archiving twice keeps the first date.
  await db.account.updateMany({ where: { id: account.id, archivedAt: null }, data: { archivedAt: new Date() } });
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
  const household = await db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } });
  if (!household.timeZone) throw new AccountInputError("time_zone_required");
  // ISO dates compare correctly as strings.
  if (input.asOfDate > todayIn(household.timeZone, now)) throw new AccountInputError("future_date");
  const asOfDate = parseIsoDate(input.asOfDate);
  if (!asOfDate) throw new AccountInputError("future_date");

  const ids = input.entries.map((entry) => entry.accountId);
  return db.$transaction(async (tx) => {
    const accounts = await tx.account.findMany({
      where: { id: { in: ids }, householdId },
      select: { id: true, plaidItemId: true, archivedAt: true, currency: true },
    });
    if (accounts.length !== ids.length) throw new AccountInputError("account_not_found");
    if (accounts.some((a) => a.plaidItemId !== null)) throw new AccountInputError("not_manual");
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
  });
}
