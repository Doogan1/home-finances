import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { toIsoDate, type IsoDate } from "@/lib/calendar-date";
import type { AccountChoice } from "./form-drafts";
import type { RuleKind, StoredVersion } from "./versions";

/** Reads for the Bills & income pages. Every query filters on the session's household. */

export const versionInclude = {
  include: { allocations: { orderBy: { position: "asc" } } },
  orderBy: { effectiveFrom: "asc" },
} satisfies Prisma.RuleVersionFindManyArgs;

type VersionRow = Prisma.RuleVersionGetPayload<{ include: { allocations: true } }>;

export function toStoredVersion(row: VersionRow): StoredVersion {
  return {
    id: row.id,
    effectiveFrom: toIsoDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? toIsoDate(row.effectiveTo) : null,
    amount: row.amount.toFixed(),
    recurrence: row.recurrence,
    interval: row.interval,
    anchorDate: toIsoDate(row.anchorDate),
    dayOfMonth: row.dayOfMonth,
    secondDay: row.secondDay,
    note: row.note,
    allocations: row.allocations.map((a) => ({ accountId: a.accountId, mode: a.mode, value: a.value?.toFixed() ?? null })),
  };
}

export type RuleView = {
  id: string;
  name: string;
  kind: RuleKind;
  category: string | null;
  notes: string | null;
  archivedAt: Date | null;
  paysAccount: { id: string; name: string } | null;
  versions: StoredVersion[];
};

const ruleInclude = {
  versions: versionInclude,
  paysAccount: { select: { id: true, name: true } },
} satisfies Prisma.RuleInclude;

function toRuleView(rule: Prisma.RuleGetPayload<{ include: typeof ruleInclude }>): RuleView {
  return {
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    category: rule.category,
    notes: rule.notes,
    archivedAt: rule.archivedAt,
    paysAccount: rule.paysAccount,
    versions: rule.versions.map(toStoredVersion),
  };
}

export async function listRules(db: PrismaClient, householdId: string): Promise<RuleView[]> {
  const rules = await db.rule.findMany({ where: { householdId }, include: ruleInclude, orderBy: { name: "asc" } });
  return rules.map(toRuleView);
}

export async function getRule(db: PrismaClient, householdId: string, ruleId: string): Promise<RuleView | null> {
  const rule = await db.rule.findFirst({ where: { id: ruleId, householdId }, include: ruleInclude });
  return rule ? toRuleView(rule) : null;
}

export type OverrideView = {
  scheduledOn: IsoDate;
  status: "PLANNED" | "CONFIRMED" | "PAID" | "SKIPPED";
  confirmedAmount: string | null;
  movedTo: IsoDate | null;
  note: string | null;
};

export async function listOverrides(db: PrismaClient, householdId: string, ruleId: string): Promise<OverrideView[]> {
  const rows = await db.occurrenceOverride.findMany({ where: { householdId, ruleId }, orderBy: { scheduledOn: "asc" } });
  return rows.map((row) => ({
    scheduledOn: toIsoDate(row.scheduledOn),
    status: row.status,
    confirmedAmount: row.confirmedAmount?.toFixed() ?? null,
    movedTo: row.movedTo ? toIsoDate(row.movedTo) : null,
    note: row.note,
  }));
}

/** Accounts a rule can use now: entered by hand and not archived. */
export async function listAccountChoices(db: PrismaClient, householdId: string): Promise<AccountChoice[]> {
  return db.account.findMany({
    where: { householdId, archivedAt: null, plaidItemId: null },
    select: { id: true, name: true, type: true },
    orderBy: { name: "asc" },
  });
}

/** Every account's name and type, archived ones included, for describing existing rules. */
export async function accountLookup(db: PrismaClient, householdId: string): Promise<Map<string, { name: string; type: string }>> {
  const accounts = await db.account.findMany({ where: { householdId }, select: { id: true, name: true, type: true } });
  return new Map(accounts.map((a) => [a.id, { name: a.name, type: a.type }]));
}
