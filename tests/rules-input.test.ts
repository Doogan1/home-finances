import { describe, expect, it } from "vitest";
import {
  changeFromInput,
  createRuleInput,
  editVersionInput,
  stopInput,
  updateRuleInput,
} from "@/features/rules/input";

const SPEND = "00000000-0000-4000-8000-000000000001";
const SAVINGS = "00000000-0000-4000-8000-000000000002";
const weekly = { recurrence: "WEEKLY", interval: 1, anchorDate: "2026-11-20" };
const split = [
  { accountId: SPEND, mode: "PERCENT", value: "70" },
  { accountId: SAVINGS, mode: "REMAINDER" },
];
const income = (patch: Record<string, unknown> = {}) => ({
  kind: "INCOME",
  name: " Drake paycheck ",
  amount: "$1,926.94",
  schedule: weekly,
  allocations: split,
  ...patch,
});

describe("createRuleInput", () => {
  it("reads an income rule with a split, starting on its first date", () => {
    expect(createRuleInput.parse(income())).toEqual({
      kind: "INCOME",
      name: "Drake paycheck",
      category: null,
      notes: null,
      paysAccountId: null,
      version: {
        recurrence: "WEEKLY",
        interval: 1,
        anchorDate: "2026-11-20",
        dayOfMonth: null,
        secondDay: null,
        effectiveFrom: "2026-11-20",
        amount: "1926.94",
        note: null,
        allocations: [
          { accountId: SPEND, mode: "PERCENT", value: "70" },
          { accountId: SAVINGS, mode: "REMAINDER", value: null },
        ],
      },
    });
  });

  it("keeps an explicit start date and blanks as null", () => {
    const parsed = createRuleInput.parse(income({ effectiveFrom: "2026-11-14", category: " ", note: "" }));
    expect(parsed.version.effectiveFrom).toBe("2026-11-14");
    expect(parsed.category).toBeNull();
    expect(parsed.version.note).toBeNull();
  });

  it("refuses unknown fields, like a household id", () => {
    expect(createRuleInput.safeParse(income({ householdId: SPEND })).success).toBe(false);
  });

  it("refuses amounts that aren't positive cents", () => {
    for (const amount of ["0", "12.345", "-5", "abc"]) {
      expect(createRuleInput.safeParse(income({ amount })).success).toBe(false);
    }
  });

  it("checks each kind of schedule's fields", () => {
    const ok = (schedule: unknown) => createRuleInput.safeParse(income({ schedule })).success;
    expect(ok({ recurrence: "TWICE_MONTHLY", anchorDate: "2026-11-05", dayOfMonth: 5, secondDay: 20 })).toBe(true);
    expect(ok({ recurrence: "TWICE_MONTHLY", anchorDate: "2026-11-05", dayOfMonth: 28, secondDay: 30 })).toBe(false);
    expect(ok({ recurrence: "TWICE_MONTHLY", anchorDate: "2026-11-05", dayOfMonth: 15, secondDay: 15 })).toBe(false);
    expect(ok({ recurrence: "WEEKLY", interval: 0, anchorDate: "2026-11-20" })).toBe(false);
    expect(ok({ recurrence: "WEEKLY", interval: 53, anchorDate: "2026-11-20" })).toBe(false);
    expect(ok({ recurrence: "MONTHLY", interval: 25, anchorDate: "2026-11-26", dayOfMonth: 26 })).toBe(false);
    expect(ok({ recurrence: "MONTHLY", interval: 1, anchorDate: "2026-11-26" })).toBe(false);
    expect(ok({ recurrence: "ONCE", interval: 1, anchorDate: "2026-12-15" })).toBe(false);
    expect(ok({ recurrence: "ONCE", anchorDate: "2026-02-30" })).toBe(false);
  });

  it("checks each allocation's value against its mode", () => {
    const ok = (allocations: unknown) => createRuleInput.safeParse(income({ allocations })).success;
    const rest = { accountId: SAVINGS, mode: "REMAINDER" };
    expect(ok([{ accountId: SPEND, mode: "PERCENT", value: "100" }, rest])).toBe(true);
    expect(ok([{ accountId: SPEND, mode: "PERCENT", value: "12.5" }, rest])).toBe(true);
    expect(ok([{ accountId: SPEND, mode: "FIXED", value: "1,500" }, rest])).toBe(true);
    for (const value of ["0", "100.5", "abc", "-5"]) {
      expect(ok([{ accountId: SPEND, mode: "PERCENT", value }, rest])).toBe(false);
    }
    expect(ok([{ accountId: SPEND, mode: "FIXED", value: "0" }, rest])).toBe(false);
    expect(ok([{ accountId: SAVINGS, mode: "REMAINDER", value: "5" }])).toBe(false);
    expect(ok([{ accountId: SPEND, mode: "PERCENT", value: "10" }, { accountId: SPEND, mode: "REMAINDER" }])).toBe(false);
    expect(ok([])).toBe(false);
  });
});

describe("the other bodies", () => {
  it("reads a change without a new schedule", () => {
    expect(changeFromInput.parse({ from: "2027-01-01", amount: "1826.94", allocations: split })).toEqual({
      from: "2027-01-01",
      amount: "1826.94",
      note: null,
      allocations: [
        { accountId: SPEND, mode: "PERCENT", value: "70" },
        { accountId: SAVINGS, mode: "REMAINDER", value: null },
      ],
      schedule: null,
    });
  });

  it("tells a missing end date (leave it) from null (clear it)", () => {
    const base = { amount: "10", schedule: weekly, allocations: split };
    expect(editVersionInput.parse(base).effectiveTo).toBeUndefined();
    expect(editVersionInput.parse({ ...base, effectiveTo: null }).effectiveTo).toBeNull();
    expect(editVersionInput.parse({ ...base, effectiveTo: "2027-03-05" }).effectiveTo).toBe("2027-03-05");
  });

  it("needs something to change, and a real date to stop on", () => {
    expect(updateRuleInput.safeParse({}).success).toBe(false);
    expect(updateRuleInput.parse({ category: "" })).toEqual({ category: null });
    expect(stopInput.safeParse({ on: "2027-13-01" }).success).toBe(false);
  });
});
