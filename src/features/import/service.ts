import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { createAccountInput, recordBalancesInput } from "@/features/accounts/input";
import { createManualAccount, recordBalancesIn } from "@/features/accounts/manual";
import { changeFromInput, createRuleInput } from "@/features/rules/input";
import { changeRuleFromIn, createRuleIn } from "@/features/rules/service";
import { parseIsoDate, type IsoDate } from "@/lib/calendar-date";
import { compareCashFlow, type CashFlowComparison } from "./cash-flow";
import { NO_CHOICES, parseChoices } from "./choices";
import { parseWorkbook } from "./parse";
import { planImport, type ImportPlan, type PlannedAllocation, type PlannedVersion } from "./plan";
import { compareSchedule, type ScheduleComparison } from "./schedule";
import { readSheets } from "./workbook";

/**
 * The workbook import's database side. A dry run reads the household and
 * writes nothing. Applying writes the whole plan in one transaction through
 * the same services the app's routes use (so every check they make is made
 * here too), and refuses when any question or problem is open, when the
 * household has no time zone, or when it already has imported rows.
 */

export type ImportRefusal =
  | "no_household"
  | "several_households"
  | "household_not_found"
  | "unsettled"
  | "time_zone_required"
  | "already_imported";

export class ImportRefused extends Error {
  constructor(readonly code: ImportRefusal) {
    super(code);
    this.name = "ImportRefused";
  }
}

type Reader = PrismaClient | Prisma.TransactionClient;
const IMPORT_NOTE = "Imported from the workbook";

/** The household to import into: the one given, or the only one there is. */
export async function resolveHousehold(db: PrismaClient, householdId?: string): Promise<{ id: string; name: string }> {
  const select = { id: true, name: true } as const;
  if (householdId !== undefined) {
    const found = z.uuid().safeParse(householdId).success
      ? await db.household.findUnique({ where: { id: householdId }, select })
      : null;
    if (!found) throw new ImportRefused("household_not_found");
    return found;
  }
  const households = await db.household.findMany({ select, take: 2 });
  if (households.length === 0) throw new ImportRefused("no_household");
  if (households.length > 1) throw new ImportRefused("several_households");
  return households[0];
}

/** Whether the household already has an account or rule from an import. */
export async function hasImportedRows(db: Reader, householdId: string): Promise<boolean> {
  const accounts = await db.account.count({ where: { householdId, importRef: { not: null } } });
  const rules = await db.rule.count({ where: { householdId, importRef: { not: null } } });
  return accounts + rules > 0;
}

function scheduleBody(v: PlannedVersion) {
  switch (v.recurrence) {
    case "ONCE":
      return { recurrence: v.recurrence, anchorDate: v.anchorDate };
    case "WEEKLY":
      return { recurrence: v.recurrence, interval: v.interval, anchorDate: v.anchorDate };
    case "MONTHLY":
      return { recurrence: v.recurrence, interval: v.interval, anchorDate: v.anchorDate, dayOfMonth: v.dayOfMonth };
    case "TWICE_MONTHLY":
      return { recurrence: v.recurrence, anchorDate: v.anchorDate, dayOfMonth: v.dayOfMonth, secondDay: v.secondDay };
  }
}

export type Applied = { accounts: number; snapshots: number; rules: number; versions: number; overrides: number };

export async function applyPlan(db: PrismaClient, householdId: string, plan: ImportPlan, now: Date = new Date()): Promise<Applied> {
  if (plan.questions.length > 0 || plan.problems.length > 0) throw new ImportRefused("unsettled");
  return db.$transaction(
    async (tx) => {
      // Two imports into one household run one after the other, so the check below cannot race.
      await tx.$queryRaw`select id from "Household" where id = ${householdId}::uuid for update`;
      if (await hasImportedRows(tx, householdId)) throw new ImportRefused("already_imported");
      const household = await tx.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } });
      if (!household.timeZone) throw new ImportRefused("time_zone_required");

      const accountIds = new Map<string, string>();
      const idOf = (ref: string) => {
        const id = accountIds.get(ref);
        if (id === undefined) throw new RangeError(`No account was created for ${ref}`);
        return id;
      };
      for (const a of plan.accounts) {
        const input = createAccountInput.parse({ name: a.name, kind: a.kind, ownerLabel: a.ownerLabel ?? undefined, cushion: a.cushion ?? undefined });
        const { id } = await createManualAccount(tx, householdId, input, { importRef: a.ref });
        accountIds.set(a.ref, id);
      }

      const byDate = new Map<string, { accountId: string; balance: string }[]>();
      for (const s of plan.snapshots) byDate.set(s.asOfDate, [...(byDate.get(s.asOfDate) ?? []), { accountId: idOf(s.accountRef), balance: s.balance }]);
      for (const [asOfDate, entries] of byDate) {
        await recordBalancesIn(tx, householdId, recordBalancesInput.parse({ asOfDate, note: IMPORT_NOTE, entries }), now);
      }

      const allocations = (list: PlannedAllocation[]) =>
        list.map((a) =>
          a.mode === "REMAINDER" ? { accountId: idOf(a.accountRef), mode: a.mode } : { accountId: idOf(a.accountRef), mode: a.mode, value: a.value },
        );
      const ruleIds = new Map<string, string>();
      let versions = 0;
      for (const r of plan.rules) {
        const [first, ...later] = r.versions;
        const body = {
          kind: r.kind,
          name: r.name,
          category: r.category ?? undefined,
          notes: r.notes ?? undefined,
          paysAccountId: r.paysAccountRef === null ? null : idOf(r.paysAccountRef),
          effectiveFrom: first.effectiveFrom,
          amount: first.amount,
          schedule: scheduleBody(first),
          allocations: allocations(first.allocations),
          note: first.note ?? undefined,
        };
        const { id } = await createRuleIn(tx, householdId, createRuleInput.parse(body), { importRef: r.ref });
        ruleIds.set(r.ref, id);
        versions++;
        // A later version is a "Change from…", exactly as the rule's page makes one.
        for (const v of later) {
          const change = { from: v.effectiveFrom, amount: v.amount, allocations: allocations(v.allocations), note: v.note ?? undefined };
          await changeRuleFromIn(tx, householdId, id, changeFromInput.parse(change));
          versions++;
        }
      }

      for (const o of plan.overrides) {
        const ruleId = ruleIds.get(o.ruleRef);
        const scheduledOn = parseIsoDate(o.scheduledOn);
        if (ruleId === undefined || scheduledOn === null) throw new RangeError(`No rule was created for ${o.ruleRef}`);
        await tx.occurrenceOverride.create({
          data: { householdId, ruleId, scheduledOn, status: o.status, confirmedAmount: o.confirmedAmount, note: IMPORT_NOTE },
        });
      }
      return { accounts: plan.accounts.length, snapshots: plan.snapshots.length, rules: plan.rules.length, versions, overrides: plan.overrides.length };
    },
    // One household's import is a few hundred statements; Prisma's default 5 seconds is too tight on a laptop.
    { maxWait: 10_000, timeout: 60_000 },
  );
}

export type ImportOutcome = {
  household: { id: string; name: string };
  plan: ImportPlan;
  schedule: ScheduleComparison | null;
  cashFlow: CashFlowComparison | null;
  alreadyImported: boolean;
  /** Null for a dry run. */
  applied: Applied | null;
};

export async function importWorkbook(
  db: PrismaClient,
  input: { workbook: Uint8Array; choicesText: string | null; apply: boolean; householdId?: string; now?: Date },
): Promise<ImportOutcome> {
  const household = await resolveHousehold(db, input.householdId);
  const workbook = parseWorkbook(await readSheets(input.workbook));
  const choices = input.choicesText === null ? { ok: true as const, choices: NO_CHOICES } : parseChoices(input.choicesText);
  // The UTC date: the household may have no time zone yet. Applying checks again in the household's zone.
  const today = (input.now ?? new Date()).toISOString().slice(0, 10) as IsoDate;
  const plan = planImport(workbook, choices.ok ? choices.choices : NO_CHOICES, today);
  if (!choices.ok) plan.problems.push(...choices.problems);
  const start = plan.forecastStart;
  const schedule = start === null ? null : compareSchedule(plan.rules, workbook.schedule, start);
  const cashFlow = start === null ? null : compareCashFlow(plan, workbook.cashFlow);
  const alreadyImported = await hasImportedRows(db, household.id);
  const applied = input.apply ? await applyPlan(db, household.id, plan, input.now) : null;
  return { household, plan, schedule, cashFlow, alreadyImported, applied };
}
