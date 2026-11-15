import { describe, expect, it } from "vitest";
import { compareCashFlow } from "@/features/import/cash-flow";
import { describeVersion, formatReport } from "@/features/import/report";
import { compareSchedule } from "@/features/import/schedule";
import { parsedWorkbook, planned } from "./helpers/import-fixtures";

describe("formatReport", () => {
  it("lists every rule for review, both checks, and the questions", async () => {
    const workbook = await parsedWorkbook();
    const plan = planned(workbook, {});
    const lines = formatReport(plan, compareSchedule(plan.rules, workbook.schedule, "2026-11-02"), compareCashFlow(plan, workbook.cashFlow));
    expect(lines[0]).toBe("Forecast start: 2026-11-02");
    expect(lines).toContain("Rules to create, for review (9)");
    expect(lines).toContain("  PAY-DRAKE: Drake pay (income)");
    expect(lines).toContain("    1000.00 every week, first 2026-11-06 (from 2026-11-02): ASPEND 60%, DPNC 10%, ASAV rest");
    expect(lines).toContain("  ASPEND: Everyday checking, checking, owner Shared, cushion 500.00");
    expect(lines).toContain("Bill Schedule check, 2026-11-02 to 2027-01-29 (1 earlier rows not compared)");
    expect(lines).toContain("  CITI-20261120: the schedule has 0.00, the rule 300.00 (a question)");
    expect(lines).toContain("Questions to answer in imports/choices.json (6)");
    expect(lines).toContain("  cards.GYM: Gym (40.00, Monthly) is included in a card payment: which card is it charged to? [CITI | AMEX | PNCCC]");
    expect(lines.at(-1)).toBe("  (none)"); // no problems
  });

  it("describes each kind of schedule", () => {
    const base = { effectiveFrom: "2026-11-02", effectiveTo: null, amount: "10.00", note: null, interval: 1, dayOfMonth: null, secondDay: null };
    const rest = [{ accountRef: "ASPEND", mode: "REMAINDER" as const, value: null }];
    expect(describeVersion({ ...base, recurrence: "MONTHLY", interval: 6, dayOfMonth: 15, anchorDate: "2026-12-15", allocations: rest })).toBe(
      "10.00 every 6 months on day 15, first 2026-12-15 (from 2026-11-02): ASPEND rest",
    );
    expect(
      describeVersion({ ...base, recurrence: "TWICE_MONTHLY", dayOfMonth: 15, secondDay: 30, anchorDate: "2026-11-15", effectiveTo: "2026-12-31", allocations: rest }),
    ).toBe("10.00 on days 15 and 30 each month, first 2026-11-15 (from 2026-11-02 to 2026-12-31): ASPEND rest");
  });
});
