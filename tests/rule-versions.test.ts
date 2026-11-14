import { describe, expect, it } from "vitest";
import type { Pattern } from "@/features/rules/recurrence";
import type { AllocationLike } from "@/features/rules/splits";
import {
  allocationProblem,
  planChangeFrom,
  planEdit,
  planStop,
  previewChange,
  scheduleProblem,
  type ChangeFrom,
  type StoredVersion,
} from "@/features/rules/versions";

const split: AllocationLike[] = [
  { accountId: "spend", mode: "PERCENT", value: "70" },
  { accountId: "pnc", mode: "PERCENT", value: "15" },
  { accountId: "savings", mode: "REMAINDER", value: null },
];
const weeklyFriday: Pattern = { recurrence: "WEEKLY", interval: 1, anchorDate: "2026-11-20", dayOfMonth: null, secondDay: null };
const paycheck: StoredVersion = {
  id: "v1",
  effectiveFrom: "2026-11-20",
  effectiveTo: null,
  ...weeklyFriday,
  amount: "1926.94",
  note: null,
  allocations: split,
};
const change = (patch: Partial<ChangeFrom> = {}): ChangeFrom => ({
  from: "2027-01-01",
  amount: "1826.94",
  note: "401(k) starts",
  allocations: split,
  schedule: null,
  ...patch,
});
const monthly = (anchorDate: string, dayOfMonth: number): Pattern => ({
  recurrence: "MONTHLY",
  interval: 1,
  anchorDate,
  dayOfMonth,
  secondDay: null,
});

describe("scheduleProblem", () => {
  it("needs a monthly anchor to fall on its day, after the month-end rule", () => {
    expect(scheduleProblem(monthly("2026-12-02", 1), "2026-12-01")).toBe("anchor_not_on_day");
    expect(scheduleProblem(monthly("2027-03-28", 30), "2027-03-01")).toBe("anchor_not_on_day");
    expect(scheduleProblem(monthly("2027-02-28", 31), "2027-02-01")).toBeNull();
    expect(scheduleProblem(monthly("2027-02-28", 30), "2027-02-01")).toBeNull();
  });

  it("needs the anchor not to be before the version starts", () => {
    expect(scheduleProblem(weeklyFriday, "2026-11-21")).toBe("anchor_before_start");
    expect(scheduleProblem(weeklyFriday, "2026-11-20")).toBeNull();
  });
});

describe("allocationProblem", () => {
  const cash = (a: AllocationLike) => ({ ...a, accountType: "depository" });

  it("pays a bill from exactly one account, taking the whole amount", () => {
    expect(allocationProblem("BILL", "100", [cash({ accountId: "a", mode: "REMAINDER", value: null })])).toBeNull();
    expect(allocationProblem("BILL", "100", [cash({ accountId: "a", mode: "PERCENT", value: "100" })])).toBe(
      "bill_needs_one_account",
    );
    expect(allocationProblem("BILL", "100", split.map(cash))).toBe("bill_needs_one_account");
  });

  it("never sends income to a credit card", () => {
    expect(
      allocationProblem("INCOME", "100", [{ accountId: "card", mode: "REMAINDER", value: null, accountType: "credit" }]),
    ).toBe("income_to_credit");
  });

  it("passes on split problems", () => {
    expect(allocationProblem("INCOME", "1926.94", split.map(cash))).toBeNull();
    expect(
      allocationProblem("INCOME", "100", [
        cash({ accountId: "a", mode: "FIXED", value: "150" }),
        cash({ accountId: "b", mode: "REMAINDER", value: null }),
      ]),
    ).toBe("over_allocated");
    expect(allocationProblem("INCOME", "100", [cash({ accountId: "a", mode: "PERCENT", value: "50" })])).toBe(
      "needs_one_remainder",
    );
  });
});

describe("planChangeFrom", () => {
  it("ends the current version the day before and anchors on the first date on or after", () => {
    expect(planChangeFrom([paycheck], change())).toEqual({
      ok: true,
      value: {
        endVersionId: "v1",
        endOn: "2026-12-31",
        next: {
          ...weeklyFriday,
          anchorDate: "2027-01-01",
          effectiveFrom: "2027-01-01",
          effectiveTo: null,
          amount: "1826.94",
          note: "401(k) starts",
          allocations: split,
        },
      },
    });
  });

  it("moves the anchor to the next date in the old pattern when the change date isn't one", () => {
    const plan = planChangeFrom([paycheck], change({ from: "2027-01-02" }));
    expect(plan.ok && plan.value.next.anchorDate).toBe("2027-01-08");
    expect(plan.ok && plan.value.endOn).toBe("2027-01-01");
  });

  it("refuses a change on or before the latest version's start", () => {
    expect(planChangeFrom([paycheck], change({ from: "2026-11-20" }))).toEqual({ ok: false, code: "change_not_after_start" });
  });

  it("acts on the latest version only", () => {
    const earlier: StoredVersion = { ...paycheck, effectiveTo: "2026-12-31" };
    const later: StoredVersion = { ...paycheck, id: "v2", effectiveFrom: "2027-01-01", anchorDate: "2027-01-01" };
    expect(planChangeFrom([earlier, later], change({ from: "2026-12-04" }))).toEqual({
      ok: false,
      code: "change_not_after_start",
    });
  });

  it("refuses a change after the rule has stopped, and keeps a stop date that is still ahead", () => {
    const stopped = { ...paycheck, effectiveTo: "2027-06-30" };
    expect(planChangeFrom([stopped], change({ from: "2027-07-01" }))).toEqual({ ok: false, code: "rule_ended" });
    const plan = planChangeFrom([stopped], change());
    expect(plan.ok && plan.value.next.effectiveTo).toBe("2027-06-30");
  });

  it("uses a new schedule as given, and checks it", () => {
    const plan = planChangeFrom([paycheck], change({ schedule: monthly("2027-01-15", 15) }));
    expect(plan.ok && plan.value.next.recurrence).toBe("MONTHLY");
    expect(planChangeFrom([paycheck], change({ schedule: monthly("2027-01-15", 1) }))).toEqual({
      ok: false,
      code: "anchor_not_on_day",
    });
    expect(planChangeFrom([paycheck], change({ schedule: monthly("2026-12-15", 15) }))).toEqual({
      ok: false,
      code: "anchor_before_start",
    });
  });

  it("refuses when the old pattern has no date left", () => {
    const once: StoredVersion = { ...paycheck, recurrence: "ONCE", anchorDate: "2026-12-15", effectiveFrom: "2026-12-01" };
    expect(planChangeFrom([once], change({ from: "2026-12-20" }))).toEqual({ ok: false, code: "no_later_occurrence" });
  });
});

describe("planStop", () => {
  it("ends the latest version on the day", () => {
    expect(planStop([paycheck], "2027-03-05")).toEqual({ ok: true, value: { versionId: "v1", effectiveTo: "2027-03-05" } });
  });

  it("refuses a day before the latest version starts", () => {
    expect(planStop([paycheck], "2026-11-19")).toEqual({ ok: false, code: "stop_before_version_start" });
  });
});

describe("planEdit", () => {
  const earlier: StoredVersion = { ...paycheck, effectiveTo: "2026-12-31" };
  const later: StoredVersion = { ...paycheck, id: "v2", effectiveFrom: "2027-01-01", anchorDate: "2027-01-01" };

  it("finds the version", () => {
    expect(planEdit([paycheck], "nope", paycheck)).toEqual({ ok: false, code: "version_not_found" });
  });

  it("changes or clears only the latest version's end", () => {
    expect(planEdit([earlier, later], "v1", { ...earlier, effectiveTo: "2027-01-15" })).toEqual({
      ok: false,
      code: "only_latest_version_can_end",
    });
    expect(planEdit([earlier, later], "v1", { ...earlier, effectiveTo: "2026-12-31" })).toEqual({
      ok: true,
      value: { effectiveTo: "2026-12-31" },
    });
    expect(planEdit([earlier, later], "v1", { ...earlier, effectiveTo: undefined })).toEqual({
      ok: true,
      value: { effectiveTo: "2026-12-31" },
    });
    expect(planEdit([{ ...paycheck, effectiveTo: "2027-03-05" }], "v1", { ...paycheck, effectiveTo: null })).toEqual({
      ok: true,
      value: { effectiveTo: null },
    });
  });

  it("checks the end date and the schedule", () => {
    expect(planEdit([paycheck], "v1", { ...paycheck, effectiveTo: "2026-11-19" })).toEqual({ ok: false, code: "end_before_start" });
    expect(planEdit([paycheck], "v1", { ...paycheck, anchorDate: "2026-11-13" })).toEqual({ ok: false, code: "anchor_before_start" });
  });
});

describe("previewChange", () => {
  it("shows the end date, the next dates and what each account gains or loses", () => {
    expect(previewChange([paycheck], change())).toEqual({
      ok: true,
      value: {
        endOn: "2026-12-31",
        next: [
          { date: "2027-01-01", amount: "1826.94" },
          { date: "2027-01-08", amount: "1826.94" },
          { date: "2027-01-15", amount: "1826.94" },
        ],
        perAccount: [
          { accountId: "spend", change: -7000n },
          { accountId: "pnc", change: -1500n },
          { accountId: "savings", change: -1500n },
        ],
      },
    });
  });

  it("passes on a refusal or a split problem", () => {
    expect(previewChange([paycheck], change({ from: "2026-11-01" }))).toEqual({ ok: false, code: "change_not_after_start" });
    expect(
      previewChange(
        [paycheck],
        change({
          allocations: [
            { accountId: "spend", mode: "FIXED", value: "5000" },
            { accountId: "savings", mode: "REMAINDER", value: null },
          ],
        }),
      ),
    ).toEqual({ ok: false, code: "over_allocated" });
  });
});
