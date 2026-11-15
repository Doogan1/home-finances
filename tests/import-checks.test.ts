import { describe, expect, it } from "vitest";
import { compareCashFlow, forecastInputFor } from "@/features/import/cash-flow";
import { compareSchedule } from "@/features/import/schedule";
import { buildForecast } from "@/features/forecast/engine";
import { parsedWorkbook, planned } from "./helpers/import-fixtures";
import { STANDARD_CHOICES, day } from "./helpers/workbook-fixture";

async function scheduleCheck(change?: Parameters<typeof parsedWorkbook>[0]) {
  const workbook = await parsedWorkbook(change);
  const plan = planned(workbook);
  return compareSchedule(plan.rules, workbook.schedule, plan.forecastStart!);
}

describe("compareSchedule", () => {
  it("finds the imported rules produce every schedule date, with only the answered amounts differing", async () => {
    const check = await scheduleCheck();
    expect(check.window).toEqual({ from: "2026-11-02", to: "2027-01-29" });
    expect(check.beforeStart).toBe(1);
    expect(check.missing).toEqual([]);
    expect(check.extra).toEqual([]);
    expect(check.unknownBill).toEqual([]);
    expect(check.noRows).toEqual([]);
    expect(check.stateNotCopied).toEqual([]);
    expect(check.amounts.map((a) => [a.entry.id, a.entry.expected, a.ruleRef, a.ruleAmount])).toEqual([
      ["CITI-20261120", "0.00", "CITI", "300.00"],
      ["PNCCARD-20261125", "0.00", "PNCCARD", "100.00"],
    ]);
  });

  it("reports a row on a date the rule does not produce, and the date it does produce instead", async () => {
    const check = await scheduleCheck((spec) => {
      spec["Bill Schedule"].rows[1][0] = "MORT-20261202";
      spec["Bill Schedule"].rows[1][1] = day("2026-12-02");
    });
    expect(check.missing.map((m) => m.id)).toEqual(["MORT-20261202"]);
    expect(check.extra).toEqual([{ ruleRef: "MORT", date: "2026-12-01" }]);
  });

  it("reports a semiannual bill read as monthly", async () => {
    const check = await scheduleCheck((spec) => (spec.Bills.rows[2][4] = "Monthly"));
    expect(check.extra).toEqual([{ ruleRef: "INS", date: "2027-01-15" }]);
  });

  it("reports rows for unknown bills, direct bills with no rows, and state the import does not copy", async () => {
    const check = await scheduleCheck((spec) => {
      const rows = spec["Bill Schedule"].rows;
      rows[2][0] = "GHOST-20270101";
      spec["Bill Schedule"].rows = rows.filter((row) => !String(row[0]).startsWith("INS-"));
      rows[3][5] = "Paid";
    });
    expect(check.unknownBill.map((r) => r.id)).toEqual(["GHOST-20270101"]);
    expect(check.extra).toContainEqual({ ruleRef: "MORT", date: "2027-01-01" });
    expect(check.noRows).toEqual(["INS"]);
    expect(check.stateNotCopied.map((r) => r.id)).toEqual(["DAYCARE-20261106"]);
  });
});

describe("forecastInputFor", () => {
  it("runs the engine on the planned import, with workbook ids as account and rule ids", async () => {
    const plan = planned(await parsedWorkbook());
    const input = forecastInputFor(plan, "2026-11-02", 30);
    expect(input.accounts.map((a) => [a.id, a.type, a.includeInForecast, a.cushion])).toEqual([
      ["ASPEND", "depository", true, "500.00"],
      ["ASAV", "depository", true, null],
      ["DPNC", "depository", true, null],
      ["ALEXCHK", "depository", true, null],
      ["CITI", "credit", false, null],
      ["AMEX", "credit", false, null],
      ["PNCCC", "credit", false, null],
    ]);
    expect(input.snapshots.get("PNCCC")).toMatchObject({ date: "2026-11-01", balance: "150.00" });
    expect(input.snapshots.has("AMEX")).toBe(false);
    expect(input.rules.find((r) => r.id === "CITI")?.versions[0].id).toBe("CITI#1");
    expect(input.overrides).toContainEqual({ ruleId: "CITI", scheduledOn: "2026-11-20", status: "SKIPPED", confirmedAmount: null, movedTo: null });

    const forecast = buildForecast(input);
    expect(forecast.accounts.map((a) => a.account.id)).toEqual(["ASPEND", "ALEXCHK", "DPNC", "ASAV"]);
  });
});

describe("compareCashFlow", () => {
  it("finds no difference when the saved projections match the engine", async () => {
    const workbook = await parsedWorkbook();
    expect(compareCashFlow(planned(workbook), workbook.cashFlow)).toEqual({ compared: 10, differences: [], notCompared: [] });
  });

  it("reports each day whose end-of-day balance differs", async () => {
    const workbook = await parsedWorkbook();
    // Using the rule's $300 for the November card payment instead of the schedule's $0.
    const plan = planned(workbook, { ...STANDARD_CHOICES, schedule: { "CITI-20261120": "rule", "PNCCARD-20261125": "skip" } });
    expect(compareCashFlow(plan, workbook.cashFlow).differences).toEqual([
      { date: "2026-11-20", accountRef: "ASPEND", workbook: "3800.00", app: "3500.00" },
    ]);
  });

  it("still compares before the questions are answered, leaving out rules with no account yet", async () => {
    const workbook = await parsedWorkbook();
    const plan = planned(workbook, {});
    const check = compareCashFlow(plan, workbook.cashFlow);
    expect(check.notCompared).toEqual(["Left out of the forecast until settled: STREAM, GYM"]);
    // Unanswered, both November card payments use the rule's amounts.
    expect(check.differences).toEqual([{ date: "2026-11-20", accountRef: "ASPEND", workbook: "3800.00", app: "3500.00" }]);
  });

  it("says why nothing was compared", async () => {
    const unsaved = await parsedWorkbook((spec) => {
      for (const row of spec["Cash Flow"].rows) row[9] = row[10] = { formula: "J3" };
    });
    expect(compareCashFlow(planned(unsaved), unsaved.cashFlow).notCompared).toEqual(["The Cash Flow sheet has no saved projections"]);

    const noBalance = await parsedWorkbook((spec) => {
      spec.Accounts.rows[2][4] = null;
      spec.Accounts.rows[2][5] = null;
    });
    expect(compareCashFlow(planned(noBalance), noBalance.cashFlow)).toEqual({
      compared: 5,
      differences: [],
      notCompared: ["DPNC has no balance to start from, so its projection is not compared"],
    });
  });
});
