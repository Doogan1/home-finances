import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { buildForecast } from "@/features/forecast/engine";
import { loadForecastInput } from "@/features/forecast/queries";
import { applyPlan, importWorkbook } from "@/features/import/service";
import { seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";
import { STANDARD_CHOICES, buildWorkbook, standardWorkbook } from "./helpers/workbook-fixture";

const { ownerUrl, appUrl } = inject("testDatabase");
const NY = "America/New_York";
const NOW = new Date("2026-11-14T17:00:00Z");
let owner: PrismaClient;
let app: PrismaClient;
let householdId: string;
let workbook: Uint8Array;
const answers = JSON.stringify(STANDARD_CHOICES);

beforeAll(async () => {
  owner = createTestClient(ownerUrl);
  app = createTestClient(appUrl);
  workbook = await buildWorkbook(standardWorkbook());
});
afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});
beforeEach(async () => {
  await truncateAll(owner);
  ({ householdId } = await seedPerson(owner, "owner@example.test"));
  await owner.household.update({ where: { id: householdId }, data: { timeZone: NY } });
});

async function counts(home: string = householdId) {
  return {
    accounts: await owner.account.count({ where: { householdId: home } }),
    snapshots: await owner.balanceSnapshot.count({ where: { account: { householdId: home } } }),
    rules: await owner.rule.count({ where: { householdId: home } }),
    versions: await owner.ruleVersion.count({ where: { rule: { householdId: home } } }),
    allocations: await owner.allocation.count({ where: { ruleVersion: { rule: { householdId: home } } } }),
    overrides: await owner.occurrenceOverride.count({ where: { householdId: home } }),
  };
}
const NOTHING = { accounts: 0, snapshots: 0, rules: 0, versions: 0, allocations: 0, overrides: 0 };

const run = (apply: boolean, choicesText: string | null = answers, extra: { householdId?: string; workbook?: Uint8Array } = {}) =>
  importWorkbook(app, { workbook: extra.workbook ?? workbook, choicesText, apply, householdId: extra.householdId, now: NOW });

describe("importWorkbook", () => {
  it("a dry run reports the plan and writes nothing", async () => {
    const outcome = await run(false, null);
    expect(outcome.applied).toBeNull();
    expect(outcome.alreadyImported).toBe(false);
    expect(outcome.household.id).toBe(householdId);
    expect(outcome.plan.questions).toHaveLength(6);
    expect(outcome.plan.rules).toHaveLength(9);
    expect(outcome.schedule?.window).toEqual({ from: "2026-11-02", to: "2027-01-29" });
    expect(outcome.cashFlow?.compared).toBe(10);
    expect(await counts()).toEqual(NOTHING);
  });

  it("applying writes accounts, balances, rules and per-date edits, and the forecast then reads them", async () => {
    const outcome = await run(true);
    expect(outcome.applied).toEqual({ accounts: 7, snapshots: 7, rules: 9, versions: 9, overrides: 2 });
    expect(await counts()).toEqual({ accounts: 7, snapshots: 7, rules: 9, versions: 9, allocations: 13, overrides: 2 });

    const accounts = await owner.account.findMany({ where: { householdId }, orderBy: { importRef: "asc" } });
    expect(accounts.map((a) => [a.importRef, a.name, a.type, a.includeInForecast, a.ownerLabel, a.cushion?.toFixed() ?? null])).toEqual([
      ["ALEXCHK", "Personal checking", "depository", true, "Alexis", null],
      ["AMEX", "Card two", "credit", false, "Shared", null],
      ["ASAV", "Rainy-day savings", "depository", true, "Shared", null],
      ["ASPEND", "Everyday checking", "depository", true, "Shared", "500"],
      ["CITI", "Card one", "credit", false, "Drake", null],
      ["DPNC", "Second checking", "depository", true, "Drake", null],
      ["PNCCC", "Card three", "credit", false, "Alexis", null],
    ]);
    const citi = await owner.rule.findFirstOrThrow({ where: { householdId, importRef: "CITI" }, include: { paysAccount: true } });
    expect(citi.paysAccount?.importRef).toBe("CITI");
    const skipped = await owner.occurrenceOverride.findMany({ where: { householdId }, orderBy: { scheduledOn: "asc" } });
    expect(skipped.map((o) => [o.scheduledOn.toISOString().slice(0, 10), o.status, o.note])).toEqual([
      ["2026-11-20", "SKIPPED", "Imported from the workbook"],
      ["2026-11-25", "SKIPPED", "Imported from the workbook"],
    ]);

    // The loader reads what was written, and the engine agrees with the workbook's Cash Flow.
    const input = await loadForecastInput(app, householdId, { environment: "SANDBOX", timeZone: NY, today: "2026-11-02", days: 19 });
    expect(input.rules).toHaveLength(9);
    const spend = buildForecast(input).accounts.find((a) => a.account.name === "Everyday checking");
    if (spend?.kind !== "forecast") throw new Error("the spend account should have a series");
    expect(spend.days.find((d) => d.date === "2026-11-20")?.closing).toBe(380000n);
  });

  it("writes a filled-in pay change as a second version, through Change from", async () => {
    const spec = standardWorkbook();
    spec.Settings.rows[14][1] = new Date("2026-12-01T00:00:00Z");
    spec.Settings.rows[15][1] = 1100;
    await run(true, answers, { workbook: await buildWorkbook(spec) });
    const pay = await owner.rule.findFirstOrThrow({
      where: { householdId, importRef: "PAY-DRAKE" },
      include: { versions: { orderBy: { effectiveFrom: "asc" } } },
    });
    expect(pay.versions.map((v) => [v.effectiveFrom.toISOString().slice(0, 10), v.effectiveTo?.toISOString().slice(0, 10) ?? null, v.amount.toFixed()])).toEqual([
      ["2026-11-02", "2026-11-30", "1000"],
      ["2026-12-01", null, "1100"],
    ]);
  });

  it("refuses to apply while any question is unanswered, and writes nothing", async () => {
    await expect(run(true, null)).rejects.toThrow("unsettled");
    await expect(run(true, '{"cards": {}}')).rejects.toThrow("unsettled");
    expect(await counts()).toEqual(NOTHING);
  });

  it("refuses a second import, and says so in a dry run", async () => {
    await run(true);
    const before = await counts();
    await expect(run(true)).rejects.toThrow("already_imported");
    expect(await counts()).toEqual(before);
    expect((await run(false)).alreadyImported).toBe(true);
  });

  it("refuses when the household has no time zone", async () => {
    await owner.household.update({ where: { id: householdId }, data: { timeZone: null } });
    await expect(run(true)).rejects.toThrow("time_zone_required");
    expect(await counts()).toEqual(NOTHING);
  });

  it("writes all of it or none of it", async () => {
    const outcome = await run(false);
    // A per-date edit the database refuses, written last: everything before it must roll back.
    const plan = { ...outcome.plan, overrides: [{ ruleRef: "CITI", scheduledOn: "2026-11-20", status: "CONFIRMED" as const, confirmedAmount: "-5.00" }] };
    await expect(applyPlan(app, householdId, plan, NOW)).rejects.toThrow(/OccurrenceOverride_confirmed_positive/);
    expect(await counts()).toEqual(NOTHING);
  });

  it("refuses a file that is not a readable workbook", async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => (i * 37) % 251);
    await expect(run(false, answers, { workbook: bytes })).rejects.toMatchObject({ name: "ImportRefused", code: "unreadable_workbook" });
    await expect(run(true, answers, { workbook: new Uint8Array() })).rejects.toThrow("unreadable_workbook");
    expect(await counts()).toEqual(NOTHING);
  });

  it("keeps to one household", async () => {
    const other = await seedPerson(owner, "other@example.test");
    await owner.household.update({ where: { id: other.householdId }, data: { timeZone: NY } });
    await expect(run(false)).rejects.toThrow("several_households");
    await expect(run(false, answers, { householdId: "not-a-uuid" })).rejects.toThrow("household_not_found");

    await run(true, answers, { householdId: other.householdId });
    expect(await counts()).toEqual(NOTHING);
    expect((await counts(other.householdId)).rules).toBe(9);
    // The other household's import does not count as this one's.
    expect((await run(false, answers, { householdId })).alreadyImported).toBe(false);
    await run(true, answers, { householdId });
    expect((await counts()).rules).toBe(9);
  });

  it("does not mind hand-entered accounts that were there before", async () => {
    await owner.account.create({ data: { householdId, name: "Old wallet", type: "depository", subtype: "checking", currency: "USD" } });
    await run(true);
    expect((await counts()).accounts).toBe(8);
  });
});
