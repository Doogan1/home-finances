import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

const { ownerUrl, appUrl } = inject("testDatabase");
let owner: PrismaClient;
let app: PrismaClient;
let householdId: string;
let accountId: string;

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

beforeAll(() => {
  owner = createTestClient(ownerUrl);
  app = createTestClient(appUrl);
});
afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});
beforeEach(async () => {
  await truncateAll(owner);
  ({ householdId } = await seedPerson(owner, "owner@example.test"));
  ({ id: accountId } = await owner.account.create({
    data: { householdId, name: "Ally Spend", type: "depository", subtype: "checking", currency: "USD" },
  }));
});

async function rule(name = "Mortgage") {
  return app.rule.create({ data: { householdId, name, kind: "BILL" } });
}
async function version(ruleId: string, data: Partial<Prisma.RuleVersionUncheckedCreateInput> = {}) {
  return app.ruleVersion.create({
    data: {
      ruleId,
      effectiveFrom: d("2026-12-01"),
      amount: "1840.91",
      recurrence: "MONTHLY",
      anchorDate: d("2026-12-01"),
      dayOfMonth: 1,
      ...data,
    },
  });
}
async function allocation(ruleVersionId: string, data: Partial<Prisma.AllocationUncheckedCreateInput> = {}) {
  return app.allocation.create({ data: { ruleVersionId, accountId, mode: "REMAINDER", ...data } });
}

describe("database rules for bills and income", () => {
  it("lets the app role write a rule, a version, an allocation and a per-date edit", async () => {
    const r = await rule();
    const v = await version(r.id);
    await allocation(v.id);
    await app.occurrenceOverride.create({ data: { householdId, ruleId: r.id, scheduledOn: d("2026-12-01"), status: "PAID" } });
    expect(await app.allocation.count()).toBe(1);
    expect(await app.occurrenceOverride.count()).toBe(1);
  });

  it("never lets two versions of one rule overlap", async () => {
    const r = await rule();
    await version(r.id, { effectiveTo: d("2026-12-31") });
    await expect(version(r.id, { effectiveFrom: d("2026-12-31"), anchorDate: d("2027-01-01") })).rejects.toThrow(
      /RuleVersion_no_overlap/,
    );
    await expect(version(r.id, { effectiveFrom: d("2027-01-01"), anchorDate: d("2027-01-01") })).resolves.toBeTruthy();
  });

  it("treats an open-ended version as running forever", async () => {
    const r = await rule();
    await version(r.id);
    await expect(version(r.id, { effectiveFrom: d("2030-01-01"), anchorDate: d("2030-01-01") })).rejects.toThrow(
      /RuleVersion_no_overlap/,
    );
  });

  it("lets different rules share dates", async () => {
    await version((await rule("Mortgage")).id);
    await expect(version((await rule("Internet")).id)).resolves.toBeTruthy();
  });

  it("keeps a version's dates in order", async () => {
    const r = await rule();
    await expect(version(r.id, { effectiveTo: d("2026-11-30") })).rejects.toThrow(/RuleVersion_dates_ordered/);
    await expect(version(r.id, { anchorDate: d("2026-11-01") })).rejects.toThrow(/RuleVersion_dates_ordered/);
  });

  it("needs a positive amount and interval", async () => {
    const r = await rule();
    await expect(version(r.id, { amount: "0" })).rejects.toThrow(/RuleVersion_amount_positive/);
    await expect(version(r.id, { interval: 0 })).rejects.toThrow(/RuleVersion_interval_positive/);
  });

  it("keeps days of the month between 1 and 31", async () => {
    const r = await rule();
    await expect(version(r.id, { dayOfMonth: 32 })).rejects.toThrow(/RuleVersion_days_in_range/);
  });

  it("keeps twice-a-month days apart, early enough and every month", async () => {
    const r = await rule();
    const twice = { recurrence: "TWICE_MONTHLY" as const, dayOfMonth: 5, secondDay: 20 };
    await expect(version(r.id, { ...twice, dayOfMonth: 28, secondDay: 30 })).rejects.toThrow(/RuleVersion_twice_monthly_shape/);
    await expect(version(r.id, { ...twice, secondDay: 5 })).rejects.toThrow(/RuleVersion_twice_monthly_shape/);
    await expect(version(r.id, { ...twice, secondDay: null })).rejects.toThrow(/RuleVersion_twice_monthly_shape/);
    await expect(version(r.id, { ...twice, interval: 2 })).rejects.toThrow(/RuleVersion_twice_monthly_shape/);
    await expect(version(r.id, twice)).resolves.toBeTruthy();
  });

  it("needs a day for monthly, and no days for weekly or once", async () => {
    const r = await rule();
    await expect(version(r.id, { dayOfMonth: null })).rejects.toThrow(/RuleVersion_monthly_has_day/);
    await expect(version(r.id, { recurrence: "WEEKLY", dayOfMonth: 3 })).rejects.toThrow(/RuleVersion_no_days_unless_monthly/);
    await expect(version(r.id, { recurrence: "ONCE", dayOfMonth: null, secondDay: 4 })).rejects.toThrow(
      /RuleVersion_no_days_unless_monthly/,
    );
  });

  it("matches an allocation's value to its mode", async () => {
    const v = await version((await rule()).id);
    for (const data of [
      { mode: "PERCENT" as const, value: "0" },
      { mode: "PERCENT" as const, value: "100.01" },
      { mode: "PERCENT" as const, value: null },
      { mode: "FIXED" as const, value: "0" },
      { mode: "REMAINDER" as const, value: "5" },
    ]) {
      await expect(allocation(v.id, data)).rejects.toThrow(/Allocation_value_fits_mode/);
    }
    await expect(allocation(v.id, { mode: "PERCENT", value: "100" })).resolves.toBeTruthy();
  });

  it("allows one remainder per version, and one allocation per account", async () => {
    const r = await rule();
    const v1 = await version(r.id, { effectiveTo: d("2026-12-31") });
    const second = await owner.account.create({
      data: { householdId, name: "Ally Savings", type: "depository", subtype: "savings", currency: "USD" },
    });
    await allocation(v1.id);
    await expect(allocation(v1.id, { accountId: second.id })).rejects.toThrow(/Allocation_one_remainder/);
    await expect(allocation(v1.id, { mode: "FIXED", value: "5" })).rejects.toThrow();
    const v2 = await version(r.id, { effectiveFrom: d("2027-01-01"), anchorDate: d("2027-01-01") });
    await expect(allocation(v2.id)).resolves.toBeTruthy();
  });

  it("refuses a non-positive confirmed amount, and a second edit for the same date", async () => {
    const r = await rule();
    const edit = { householdId, ruleId: r.id, scheduledOn: d("2026-12-01") };
    await expect(app.occurrenceOverride.create({ data: { ...edit, confirmedAmount: "0" } })).rejects.toThrow(
      /OccurrenceOverride_confirmed_positive/,
    );
    await app.occurrenceOverride.create({ data: edit });
    await expect(app.occurrenceOverride.create({ data: edit })).rejects.toThrow();
  });

  it("removes a rule's versions and allocations with it, and keeps an account in use from being deleted", async () => {
    const r = await rule();
    await allocation((await version(r.id)).id);
    await expect(app.account.delete({ where: { id: accountId } })).rejects.toThrow();
    await owner.rule.delete({ where: { id: r.id } });
    expect(await owner.ruleVersion.count()).toBe(0);
    expect(await owner.allocation.count()).toBe(0);
  });
});
