import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { parseIsoDate, type IsoDate } from "@/lib/calendar-date";
import type { ChangeFromInput, CreateRuleInput, EditVersionInput, StopInput, UpdateRuleInput } from "./input";
import { toStoredVersion, versionInclude } from "./queries";
import type { AllocationLike } from "./splits";
import {
  allocationProblem,
  planChangeFrom,
  planEdit,
  planStop,
  scheduleProblem,
  type RuleErrorCode,
  type RuleKind,
  type VersionDraft,
} from "./versions";

/**
 * Writes for bills and income. Every function takes the household id from the
 * caller's session and filters on it. Each action is one transaction, and the
 * ones that change versions lock the rule's row first, so two edits to one
 * rule run one after the other and each plans from the other's result. The
 * database's own constraints stay the last line of defence.
 */

export class RuleInputError extends Error {
  constructor(readonly code: RuleErrorCode) {
    super(code);
    this.name = "RuleInputError";
  }
}

type Tx = Prisma.TransactionClient;

function throwIf(problem: RuleErrorCode | null): void {
  if (problem) throw new RuleInputError(problem);
}

function dateOf(value: IsoDate): Date {
  const date = parseIsoDate(value);
  if (!date) throw new RangeError(`Not a date: ${value}`);
  return date;
}

const optionalDate = (value: IsoDate | null) => (value === null ? null : dateOf(value));

async function checkAllocations(tx: Tx, householdId: string, kind: RuleKind, amount: string, allocations: AllocationLike[]) {
  const accounts = await tx.account.findMany({
    where: { householdId, id: { in: allocations.map((a) => a.accountId) } },
    select: { id: true, type: true, plaidItemId: true, archivedAt: true },
  });
  if (accounts.length !== allocations.length) throw new RuleInputError("account_not_found");
  if (accounts.some((a) => a.archivedAt !== null)) throw new RuleInputError("account_archived");
  if (accounts.some((a) => a.plaidItemId !== null)) throw new RuleInputError("account_linked");
  const typeOf = new Map(accounts.map((a) => [a.id, a.type]));
  throwIf(allocationProblem(kind, amount, allocations.map((a) => ({ ...a, accountType: typeOf.get(a.accountId) ?? "" }))));
}

async function checkPaysAccount(tx: Tx, householdId: string, kind: RuleKind, paysAccountId: string | null) {
  if (paysAccountId === null) return;
  if (kind !== "BILL") throw new RuleInputError("pays_account_invalid");
  const card = await tx.account.findFirst({
    where: { id: paysAccountId, householdId, type: "credit", archivedAt: null, plaidItemId: null },
    select: { id: true },
  });
  if (!card) throw new RuleInputError("pays_account_invalid");
}

function versionColumns(draft: VersionDraft) {
  return {
    amount: draft.amount,
    recurrence: draft.recurrence,
    interval: draft.interval,
    anchorDate: dateOf(draft.anchorDate),
    dayOfMonth: draft.dayOfMonth,
    secondDay: draft.secondDay,
    note: draft.note,
  };
}

const allocationRows = (allocations: AllocationLike[]) =>
  allocations.map((a, position) => ({ accountId: a.accountId, mode: a.mode, value: a.value, position }));

/** Locks the rule's row for the rest of the transaction, then reads it. */
async function lockRule(tx: Tx, householdId: string, ruleId: string) {
  await tx.$queryRaw`select id from "Rule" where id = ${ruleId}::uuid and "householdId" = ${householdId}::uuid for update`;
  const rule = await tx.rule.findFirst({ where: { id: ruleId, householdId }, include: { versions: versionInclude } });
  if (!rule) throw new RuleInputError("rule_not_found");
  if (rule.archivedAt) throw new RuleInputError("rule_archived");
  return { kind: rule.kind, versions: rule.versions.map(toStoredVersion) };
}

export async function createRule(db: PrismaClient, householdId: string, input: CreateRuleInput) {
  return db.$transaction((tx) => createRuleIn(tx, householdId, input));
}

/** createRule inside a transaction the caller holds. `importRef` is set only by the workbook import. */
export async function createRuleIn(tx: Tx, householdId: string, input: CreateRuleInput, options: { importRef?: string } = {}) {
  const { version } = input;
  throwIf(scheduleProblem(version, version.effectiveFrom));
  await checkAllocations(tx, householdId, input.kind, version.amount, version.allocations);
  await checkPaysAccount(tx, householdId, input.kind, input.paysAccountId);
  return tx.rule.create({
    data: {
      householdId,
      name: input.name,
      kind: input.kind,
      category: input.category,
      notes: input.notes,
      paysAccountId: input.paysAccountId,
      importRef: options.importRef ?? null,
      versions: {
        create: {
          effectiveFrom: dateOf(version.effectiveFrom),
          ...versionColumns(version),
          allocations: { create: allocationRows(version.allocations) },
        },
      },
    },
    select: { id: true },
  });
}

export async function updateRule(db: PrismaClient, householdId: string, ruleId: string, input: UpdateRuleInput) {
  await db.$transaction(async (tx) => {
    const rule = await lockRule(tx, householdId, ruleId);
    if (input.paysAccountId !== undefined) await checkPaysAccount(tx, householdId, rule.kind, input.paysAccountId);
    await tx.rule.update({
      where: { id: ruleId },
      data: { name: input.name, category: input.category, notes: input.notes, paysAccountId: input.paysAccountId },
    });
  });
}

export async function changeRuleFrom(db: PrismaClient, householdId: string, ruleId: string, input: ChangeFromInput) {
  return db.$transaction((tx) => changeRuleFromIn(tx, householdId, ruleId, input));
}

/** changeRuleFrom inside a transaction the caller holds. */
export async function changeRuleFromIn(tx: Tx, householdId: string, ruleId: string, input: ChangeFromInput) {
  const rule = await lockRule(tx, householdId, ruleId);
  const plan = planChangeFrom(rule.versions, input);
  if (!plan.ok) throw new RuleInputError(plan.code);
  const { endVersionId, endOn, next } = plan.value;
  await checkAllocations(tx, householdId, rule.kind, next.amount, next.allocations);
  // End the old version first: the new one may not overlap it, even for a moment.
  await tx.ruleVersion.update({ where: { id: endVersionId }, data: { effectiveTo: dateOf(endOn) } });
  const created = await tx.ruleVersion.create({
    data: {
      ruleId,
      effectiveFrom: dateOf(next.effectiveFrom),
      effectiveTo: optionalDate(next.effectiveTo),
      ...versionColumns(next),
      allocations: { create: allocationRows(next.allocations) },
    },
    select: { id: true },
  });
  return { versionId: created.id };
}

export async function stopRule(db: PrismaClient, householdId: string, ruleId: string, input: StopInput) {
  await db.$transaction(async (tx) => {
    const rule = await lockRule(tx, householdId, ruleId);
    const plan = planStop(rule.versions, input.on);
    if (!plan.ok) throw new RuleInputError(plan.code);
    await tx.ruleVersion.update({ where: { id: plan.value.versionId }, data: { effectiveTo: dateOf(plan.value.effectiveTo) } });
  });
}

export async function editRuleVersion(
  db: PrismaClient,
  householdId: string,
  ruleId: string,
  versionId: string,
  input: EditVersionInput,
) {
  await db.$transaction(async (tx) => {
    const rule = await lockRule(tx, householdId, ruleId);
    const plan = planEdit(rule.versions, versionId, input);
    if (!plan.ok) throw new RuleInputError(plan.code);
    await checkAllocations(tx, householdId, rule.kind, input.amount, input.allocations);
    await tx.allocation.deleteMany({ where: { ruleVersionId: versionId } });
    await tx.ruleVersion.update({
      where: { id: versionId },
      data: {
        ...versionColumns(input),
        effectiveTo: optionalDate(plan.value.effectiveTo),
        allocations: { create: allocationRows(input.allocations) },
      },
    });
  });
}

export async function archiveRule(db: PrismaClient, householdId: string, ruleId: string) {
  const rule = await db.rule.findFirst({ where: { id: ruleId, householdId }, select: { id: true } });
  if (!rule) throw new RuleInputError("rule_not_found");
  // Guarded so archiving twice keeps the first date.
  await db.rule.updateMany({ where: { id: rule.id, archivedAt: null }, data: { archivedAt: new Date() } });
}
