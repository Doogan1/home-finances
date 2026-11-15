import { describe, expect, it } from "vitest";
import { dateOf, dayOf, moneyOf, parseWorkbook, shareOf } from "@/features/import/parse";
import { readSheets } from "@/features/import/workbook";
import { buildWorkbook, day, standardWorkbook, type WorkbookSpec } from "./helpers/workbook-fixture";

async function parsed(change: (spec: WorkbookSpec) => void = () => {}) {
  const spec = standardWorkbook();
  change(spec);
  return parseWorkbook(await readSheets(await buildWorkbook(spec)));
}

describe("cell conversions", () => {
  it("reads amounts exactly, as two-decimal strings", () => {
    expect(moneyOf(1840.91, "x")).toBe("1840.91");
    expect(moneyOf(-12.4, "x")).toBe("-12.40");
    expect(moneyOf(1500, "x")).toBe("1500.00");
    expect(moneyOf(0.1 + 0.2, "x")).toBe("0.30"); // binary noise is not a third decimal
    expect(moneyOf("$1,500", "x")).toBe("1500.00");
    expect(moneyOf(null, "x")).toBeNull();
    expect(() => moneyOf(12.345, "Amount")).toThrow("Amount has more than two decimal places");
    expect(() => moneyOf("lots", "Amount")).toThrow("Amount is not an amount");
  });

  it("reads dates from date cells, date serials and ISO text", () => {
    expect(dateOf(day("2026-11-02"), "x")).toBe("2026-11-02");
    expect(dateOf(new Date("2026-11-02T15:30:00Z"), "x")).toBe("2026-11-02"); // a datetime keeps its day
    expect(dateOf(46328, "x")).toBe("2026-11-02");
    expect(dateOf("2026-11-02", "x")).toBe("2026-11-02");
    expect(dateOf(null, "x")).toBeNull();
    expect(() => dateOf("soon", "Due date")).toThrow("Due date is not a date");
  });

  it("rejects a serial outside Excel's dates and an invalid date, instead of inventing a date", () => {
    expect(() => dateOf(20261102, "Due date")).toThrow("Due date is not a date");
    expect(() => dateOf(1e9, "Due date")).toThrow("Due date is not a date");
    expect(() => dateOf(-5, "Due date")).toThrow("Due date is not a date");
    expect(() => dateOf(Number.NaN, "Due date")).toThrow("Due date is not a date");
    expect(() => dateOf(new Date("not a date"), "Due date")).toThrow("Due date is not a date");
    expect(dateOf(2958465, "x")).toBe("9999-12-31"); // Excel's last date is still a date
  });

  it("reads a day of the month", () => {
    expect(dayOf(31, "x")).toBe(31);
    expect(dayOf("5", "x")).toBe(5);
    expect(dayOf(null, "x")).toBeNull();
    expect(() => dayOf(32, "Due day")).toThrow("Due day is not a day of the month (1 to 31)");
    expect(() => dayOf(2.5, "Due day")).toThrow();
    expect(() => dayOf(new Date("not a date"), "Due day")).toThrow("Due day is not a day of the month (1 to 31)");
  });

  it("reads a share stored as a fraction or typed as a percentage", () => {
    expect(shareOf(0.7, "x")).toBe("70"); // a percent-formatted cell holds 0.7
    expect(shareOf(0.125, "x")).toBe("12.5");
    expect(shareOf(1, "x")).toBe("100");
    expect(shareOf(0, "x")).toBe("0");
    expect(shareOf(70, "x")).toBe("70"); // typed into a plain cell
    expect(shareOf(12.5, "x")).toBe("12.5");
    expect(shareOf("70%", "x")).toBe("70");
    expect(shareOf("0.7", "x")).toBe("70");
    expect(shareOf(null, "x")).toBeNull();
    expect(() => shareOf(150, "Share")).toThrow("Share is not between 0% and 100%");
    expect(() => shareOf(1 / 3, "Share")).toThrow("Share has more than two decimal places as a percentage");
  });
});

describe("parseWorkbook", () => {
  it("reads every sheet of the standard workbook with no problems", async () => {
    const workbook = await parsed();
    expect(workbook.problems).toEqual([]);
    expect(workbook.accounts).toHaveLength(7);
    expect(workbook.accounts[0]).toEqual({
      row: 4,
      id: "ASPEND",
      name: "Everyday checking",
      type: "Checking",
      owner: "Shared",
      balance: "2000.00",
      balanceDate: "2026-11-02",
    });
    expect(workbook.accounts.find((a) => a.id === "AMEX")).toMatchObject({ type: "Credit card", balance: null, balanceDate: null });
    expect(workbook.history.map((h) => [h.row, h.accountId, h.asOfDate, h.balance])).toEqual([
      [4, "ASPEND", "2026-11-02", "1990.00"],
      [5, "PNCCC", "2026-10-31", "175.00"],
      [6, "ASAV", "2026-11-02", "5000.00"],
    ]);
  });

  it("finds settings by their label and reads shares either way", async () => {
    const { settings } = await parsed();
    expect(settings).toEqual({
      forecastStart: "2026-11-02",
      cushion: "500.00",
      drake: {
        weeklyNet: "1000.00",
        firstPayday: "2026-11-06",
        spendShare: "60",
        pncShare: "10",
        savingsShare: "30",
        changeFrom: null,
        changedNet: null,
        notes: "Drake first payday: UNCONFIRMED",
      },
      alexis: {
        semiMonthlyNet: "1500.00",
        payDay1: 15,
        payDay2: 30,
        spendShare: "50",
        personalShare: "20",
        savingsShare: "30",
        changeFrom: null,
        changedNet: null,
        notes: null,
      },
    });
  });

  it("finds a setting wherever its row is", async () => {
    const { settings } = await parsed((spec) => spec.Settings.rows.reverse());
    expect(settings?.drake.firstPayday).toBe("2026-11-06");
  });

  it("names a missing or doubled setting", async () => {
    const missing = await parsed((spec) => {
      spec.Settings.rows = spec.Settings.rows.filter((row) => row[0] !== "Drake net weekly");
    });
    expect(missing.settings).toBeNull();
    expect(missing.problems).toEqual(['Settings: no row is labelled "Drake net weekly"']);

    const doubled = await parsed((spec) => spec.Settings.rows.push(["Forecast start", day("2026-12-01"), null, null]));
    expect(doubled.problems).toEqual(['Settings: more than one row is labelled "Forecast start" (rows 4, 25)']);
  });

  it("reads bills up to the first row with no Bill ID", async () => {
    const { bills } = await parsed();
    expect(bills.map((b) => b.id)).toEqual(["MORT", "DAYCARE", "INS", "CITI", "PNCCARD", "STREAM", "GYM"]);
    expect(bills[0]).toEqual({
      row: 4,
      id: "MORT",
      name: "Home loan",
      category: "Housing",
      amount: "1200.00",
      frequency: "Monthly",
      paymentAccount: "Everyday checking",
      treatment: "Direct",
      dueDay: 1,
      method: "Autopay",
      notes: "Fixed rate",
    });
    expect(bills[5]).toMatchObject({ id: "STREAM", amount: "15.49", treatment: "Included in card payment" });
  });

  it("reads the schedule's saved amounts and the bill id from each row's ID", async () => {
    const { schedule } = await parsed();
    expect(schedule[1]).toEqual({
      row: 5,
      id: "MORT-20261201",
      billId: "MORT",
      dueDate: "2026-12-01",
      expected: "1200.00",
      status: "Planned",
      confirmed: null,
    });
    expect(schedule.find((s) => s.id === "CITI-20261120")?.expected).toBe("0.00");
    expect(schedule.filter((s) => s.billId === "DAYCARE")).toHaveLength(13);
  });

  it("reads the Cash Flow sheet's saved projections", async () => {
    const { cashFlow } = await parsed();
    expect(cashFlow[1]).toEqual({ row: 5, date: "2026-11-06", spend: "2350.00", pnc: "900.00" });
  });

  it("turns unreadable cells into problems naming the sheet and row, and leaves the row out", async () => {
    const workbook = await parsed((spec) => {
      spec.Bills.rows[1][4] = "Fortnightly";
      spec.Accounts.rows[0][5] = null; // a balance with no date
      spec["Bill Schedule"].rows[1][4] = { formula: "Bills!D4" }; // never calculated
    });
    expect(workbook.problems).toEqual([
      "Accounts row 4: Latest balance has no snapshot date",
      'Bills row 5: Frequency "Fortnightly" is not one of Monthly, Weekly, Semiannual',
      "Bill Schedule row 5: Expected has no saved amount",
    ]);
    expect(workbook.bills.map((b) => b.id)).not.toContain("DAYCARE");
  });

  it("turns a date cell that is not a date into a problem naming the row, and never throws", async () => {
    const serial = await parsed((spec) => {
      spec["Balance History"].rows[0][2] = 20261102; // a date cell holding a plain number far past 9999
    });
    expect(serial.problems).toEqual(["Balance History row 4: As-of date is not a date"]);
    expect(serial.history.map((h) => h.row)).toEqual([5, 6]);

    const huge = await parsed((spec) => {
      spec["Balance History"].rows[0][2] = 1e9;
    });
    expect(huge.problems).toEqual(["Balance History row 4: As-of date is not a date"]);

    const invalid = await parsed((spec) => {
      spec["Balance History"].rows[0][2] = new Date("not a date");
    });
    expect(invalid.problems).toEqual(["Balance History row 4: As-of date is not a date"]);

    const blankId = await parsed((spec) => {
      spec.Accounts.rows[0][0] = new Date("not a date"); // an invalid date in column A
    });
    expect(blankId.problems).toEqual(["Accounts row 4: A cell is not a date"]);
    expect(blankId.accounts.map((a) => a.row)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it("needs the Accounts, Settings, Bills and Bill Schedule sheets, but not Cash Flow", async () => {
    const workbook = await parsed((spec) => {
      delete spec.Bills;
      delete spec["Cash Flow"];
    });
    expect(workbook.problems).toEqual(['The workbook has no "Bills" sheet']);
    expect(workbook.cashFlow).toEqual([]);
  });
});
