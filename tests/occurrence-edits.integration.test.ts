import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createRuleInput, occurrenceEditInput } from "@/features/rules/input";
import { resetOccurrenceEdit, saveOccurrenceEdit } from "@/features/rules/occurrence-edits";
import { listHouseholdOverrides } from "@/features/rules/queries";
import { archiveRule, createRule } from "@/features/rules/service";
import { seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

const { ownerUrl, appUrl } = inject("testDatabase");
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

let owner: PrismaClient;
let app: PrismaClient;
let householdId: string;
let userId: string;
let ruleId: string;

beforeAll(() => {
  owner = createTestClient(ownerUrl);
  app = createTestClient(appUrl);
});
afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});

let spendId: string;
const mortgage = () =>
  createRuleInput.parse({
    kind: "BILL",
    name: "Mortgage",
    amount: "1840.91",
    schedule: { recurrence: "MONTHLY", interval: 1, anchorDate: "2026-12-01", dayOfMonth: 1 },
    allocations: [{ accountId: spendId, mode: "REMAINDER" }],
  });

beforeEach(async () => {
  await truncateAll(owner);
  ({ householdId, userId } = await seedPerson(owner, "owner@example.test"));
  spendId = (await owner.account.create({ data: { householdId, name: "Ally Spend", type: "depository", subtype: "checking", currency: "USD" } })).id;
  ruleId = (await createRule(app, householdId, mortgage())).id;
});

const edit = (patch: Record<string, unknown> = {}) =>
  occurrenceEditInput.parse({ status: "PLANNED", confirmedAmount: null, movedTo: null, note: null, ...patch });
const save = (scheduledOn: string, patch: Record<string, unknown> = {}, home = householdId, rule = ruleId) =>
  saveOccurrenceEdit(app, home, userId, rule, scheduledOn, edit(patch));

describe("saveOccurrenceEdit", () => {
  it("saves an edit keyed by the scheduled date, with who made it, and a second save replaces it", async () => {
    await expect(save("2026-12-01", { status: "CONFIRMED", confirmedAmount: "1,900.25", note: "statement" })).resolves.toEqual({ saved: true });
    const [row] = await owner.occurrenceOverride.findMany({ where: { ruleId } });
    expect(row).toMatchObject({ householdId, scheduledOn: d("2026-12-01"), status: "CONFIRMED", movedTo: null, note: "statement", updatedByUserId: userId });
    expect(row.confirmedAmount?.toFixed()).toBe("1900.25");

    await save("2026-12-01", { status: "PAID", movedTo: "2026-12-03" });
    expect(await listHouseholdOverrides(app, householdId)).toEqual([
      { ruleId, scheduledOn: "2026-12-01", status: "PAID", confirmedAmount: null, movedTo: "2026-12-03", note: null },
    ]);
  });

  it("refuses Confirmed with no amount, a date the rule does not produce, and a move too far", async () => {
    await expect(save("2026-12-01", { status: "CONFIRMED" })).rejects.toMatchObject({ code: "confirmed_needs_amount" });
    await expect(save("2026-12-02", { status: "PAID" })).rejects.toMatchObject({ code: "occurrence_not_found" });
    await expect(save("2026-12-01", { movedTo: "2027-02-02" })).rejects.toMatchObject({ code: "move_out_of_range" });
    await expect(save("2026-12-01", { movedTo: "2027-02-01" })).resolves.toEqual({ saved: true });
    await expect(save("2027-01-01", { movedTo: "2026-10-31" })).resolves.toEqual({ saved: true }); // 62 days back
    expect(await owner.occurrenceOverride.count()).toBe(2);
  });

  it("stores a move to the scheduled date as no move, and deletes an edit that says nothing", async () => {
    await save("2026-12-01", { movedTo: "2026-12-01", note: "check" });
    expect((await owner.occurrenceOverride.findFirstOrThrow({ where: { ruleId } })).movedTo).toBeNull();

    await expect(save("2026-12-01")).resolves.toEqual({ saved: false });
    expect(await owner.occurrenceOverride.count()).toBe(0);
  });

  it("only edits this household's rules, and not archived ones", async () => {
    const other = await seedPerson(owner, "other@example.test");
    await expect(save("2026-12-01", { status: "PAID" }, other.householdId)).rejects.toMatchObject({ code: "rule_not_found" });

    await archiveRule(app, householdId, ruleId);
    await expect(save("2026-12-01", { status: "PAID" })).rejects.toMatchObject({ code: "rule_archived" });
    expect(await owner.occurrenceOverride.count()).toBe(0);
  });
});

describe("resetOccurrenceEdit", () => {
  it("deletes the edit, including one for a date the rule no longer produces", async () => {
    await owner.occurrenceOverride.create({ data: { householdId, ruleId, scheduledOn: d("2026-12-02"), status: "SKIPPED" } });
    await expect(resetOccurrenceEdit(app, householdId, ruleId, "2026-12-02")).resolves.toEqual({ removed: 1 });
    await expect(resetOccurrenceEdit(app, householdId, ruleId, "2026-12-02")).resolves.toEqual({ removed: 0 });
  });

  it("never touches another household's edits", async () => {
    await save("2026-12-01", { status: "PAID" });
    const other = await seedPerson(owner, "other@example.test");
    await expect(resetOccurrenceEdit(app, other.householdId, ruleId, "2026-12-01")).rejects.toMatchObject({ code: "rule_not_found" });
    expect(await owner.occurrenceOverride.count()).toBe(1);
  });
});
