import { describe, expect, it } from "vitest";
import { cellAt, plainValue, readSheets } from "@/features/import/workbook";
import { buildWorkbook, day, standardWorkbook } from "./helpers/workbook-fixture";

describe("plainValue", () => {
  it("keeps plain values and reads a formula as its saved result", () => {
    expect(plainValue(12.5)).toBe(12.5);
    expect(plainValue("Direct")).toBe("Direct");
    expect(plainValue(null)).toBeNull();
    expect(plainValue(undefined)).toBeNull();
    expect(plainValue({ formula: "Bills!D4", result: 1200 })).toBe(1200);
    expect(plainValue({ sharedFormula: "J4", result: -5 })).toBe(-5);
  });

  it("reads a formula with no saved result, or an error, as null", () => {
    expect(plainValue({ formula: "Bills!D4" })).toBeNull();
    expect(plainValue({ formula: "1/0", result: { error: "#DIV/0!" } })).toBeNull();
    expect(plainValue({ error: "#N/A" })).toBeNull();
  });

  it("joins rich text and reads a link as its text", () => {
    expect(plainValue({ richText: [{ text: "Ally " }, { text: "Spend" }] })).toBe("Ally Spend");
    expect(plainValue({ text: "statement", hyperlink: "https://example.test" })).toBe("statement");
  });
});

describe("readSheets", () => {
  it("reads every sheet into rows and columns from 1, with formulas as their saved results", async () => {
    const sheets = await readSheets(await buildWorkbook(standardWorkbook()));
    expect([...sheets.keys()]).toEqual([
      "START HERE",
      "Accounts",
      "Balance History",
      "Settings",
      "Bills",
      "Bill Schedule",
      "Cash Flow",
    ]);
    const accounts = sheets.get("Accounts")!;
    expect(cellAt(accounts, 3, 1)).toBe("Account ID");
    expect(cellAt(accounts, 4, 1)).toBe("ASPEND");
    expect(cellAt(accounts, 4, 5)).toBe(2000);
    expect(cellAt(accounts, 4, 6)).toEqual(day("2026-11-02"));
    expect(cellAt(accounts, 9, 5)).toBeNull(); // a blank balance
    const schedule = sheets.get("Bill Schedule")!;
    expect(cellAt(schedule, 5, 5)).toBe(1200); // =Bills!D4, read as its saved value
    expect(cellAt(schedule, 5, 2)).toEqual(day("2026-12-01"));
    const cashFlow = sheets.get("Cash Flow")!;
    expect(cellAt(cashFlow, 4, 10)).toBe(2000);
    expect(cellAt(cashFlow, 99, 99)).toBeNull();
  });
});
