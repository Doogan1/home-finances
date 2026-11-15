import ExcelJS from "exceljs";
import { addDays } from "@/lib/calendar-date";

/**
 * A synthetic workbook with the real one's sheet and column layout (title in
 * row 1, headers in row 3, data from row 4). Every account name, amount and
 * date here is made up.
 */

export type FixtureCell = string | number | Date | null | { formula: string; result?: number | string | Date };
export type FixtureSheet = { headers: string[]; rows: FixtureCell[][] };
export type WorkbookSpec = Record<string, FixtureSheet>;

export const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const f = (formula: string, result?: number | string | Date): FixtureCell => ({ formula, result });

const BILLS: FixtureCell[][] = [
  ["MORT", "Home loan", "Housing", 1200, "Monthly", "Everyday checking", "Direct", 1, "Autopay", "Fixed rate"],
  ["DAYCARE", "Childcare", "Family", 250, "Weekly", "Everyday checking", "Direct", null, "Transfer", null],
  ["INS", "Car insurance", "Insurance", 600, "Semiannual", "Second checking", "Direct", null, "Autopay", null],
  ["CITI", "Card one payment", "Debt", 300, "Monthly", "Everyday checking", "Direct", 20, "Autopay", "Estimate"],
  ["PNCCARD", "Card three payment", "Debt", 100, "Monthly", "Second checking", "Direct", 25, "Autopay", "Estimate"],
  ["STREAM", "Streaming", "Subscriptions", 15.49, "Monthly", "Everyday checking", "Included in card payment", 9, null, null],
  ["GYM", "Gym", "Health", 40, "Monthly", "Everyday checking", "Included in card payment", 5, null, null],
];

/** The Bills row (4, 5, ...) of a bill id, for `=Bills!D<n>` formulas. */
const billRow = (id: string) => 4 + BILLS.findIndex((row) => row[0] === id);

function scheduleRow(billId: string, date: string, literal?: number): FixtureCell[] {
  const bill = BILLS[billRow(billId) - 4];
  const amount = bill[3] as number;
  const expected = literal === undefined ? f(`Bills!D${billRow(billId)}`, amount) : literal;
  return [
    `${billId}-${date.replaceAll("-", "")}`,
    day(date),
    bill[1],
    bill[5],
    expected,
    "Planned",
    null,
    f(`IF(F4="Paid",0,E4)`, literal ?? amount),
    "Bills",
    null,
    date.slice(0, 7),
  ];
}

function weekly(billId: string, first: string, last: string): FixtureCell[][] {
  const rows: FixtureCell[][] = [];
  for (let date = first; date <= last; date = addDays(date, 7)) rows.push(scheduleRow(billId, date));
  return rows;
}

const cashFlowRow = (date: string, spend: number, pnc: number): FixtureCell[] => [
  day(date),
  ...Array<FixtureCell>(8).fill(null),
  f("J3+D4-H4", spend),
  f("K3+E4-I4", pnc),
  null,
  null,
  null,
  date.slice(0, 7),
  null,
];

/** A fresh copy each call, so a test can change it freely. */
export function standardWorkbook(): WorkbookSpec {
  return {
    "START HERE": { headers: ["Read me"], rows: [["Not imported"]] },
    Accounts: {
      headers: ["Account ID", "Account", "Type", "Owner", "Latest balance ($)", "Snapshot date", "Source", "Forecast status"],
      rows: [
        ["ASPEND", "Everyday checking", "Checking", "Shared", 2000, day("2026-11-02"), f("B1", "Manual"), f("B2", "OK")],
        ["ASAV", "Rainy-day savings", "Savings", "Shared", 5000, day("2026-11-02"), f("B1", "Manual"), f("B2", "OK")],
        ["DPNC", "Second checking", "Checking", "Drake", 800, day("2026-11-02"), f("B1", "Manual"), f("B2", "OK")],
        ["ALEXCHK", "Personal checking", "Checking", "Alexis", 300, day("2026-11-02"), f("B1", "Manual"), f("B2", "OK")],
        ["CITI", "Card one", "Credit card", "Drake", 400, day("2026-11-02"), f("B1", "Manual"), f("B2", "OK")],
        ["AMEX", "Card two", "Credit card", "Shared", null, null, f("B1", ""), f("B2", "NEEDS BALANCE")],
        ["PNCCC", "Card three", "Credit card", "Alexis", 150, day("2026-11-01"), f("B1", "Manual"), f("B2", "OK")],
      ],
    },
    "Balance History": {
      headers: ["Snapshot ID", "Account ID", "As-of date", "Balance ($)", "Source", "External reference", "Notes"],
      rows: [
        ["S1", "ASPEND", day("2026-11-02"), 1990, "Manual", null, "Typed before a correction"],
        ["S2", "PNCCC", day("2026-10-31"), 175, "Statement", "stmt-1", null],
        ["S3", "ASAV", day("2026-11-02"), 5000, "Manual", null, null],
      ],
    },
    Settings: {
      headers: ["Setting", "Value", "Notes", "Source"],
      rows: [
        ["Forecast start", day("2026-11-02"), null, "Chosen"],
        ["Savings APY", 0.04, null, null],
        ["Spend minimum cushion", 500, null, null],
        ["Drake net weekly", 1000, null, "Pay stub"],
        ["Drake first payday", day("2026-11-06"), "UNCONFIRMED", null],
        ["Drake Ally Spend share", 0.6, null, null],
        ["Drake PNC share", 0.1, null, null],
        ["Drake savings share", 0.3, null, null],
        ["Alexis net semi-monthly", 1500, null, null],
        ["Alexis pay date 1", 15, null, null],
        ["Alexis pay date 2", 30, null, null],
        // Typed as plain percentages rather than percent-formatted fractions.
        ["Alexis Ally Spend share", 50, null, null],
        ["Alexis personal share", 20, null, null],
        ["Alexis savings share", 30, null, null],
        ["Drake changed pay effective (optional)", null, null, null],
        ["Drake changed weekly net", null, null, null],
        ["Alexis changed pay effective (optional)", null, null, null],
        ["Alexis changed semi-monthly net", null, null, null],
        [null, null, null, null],
        ["Allocation check", f("B6+B7+B8", 1), null, null],
        ["Note: shares are of net pay", null, null, null],
      ],
    },
    Bills: {
      headers: [
        "Bill ID",
        "Obligation",
        "Category",
        "Amount ($)",
        "Frequency",
        "Payment account",
        "Cash treatment",
        "Due date / day",
        "Method",
        "Notes / source",
      ],
      rows: [...BILLS.map((row) => [...row]), [null], [null], [null, "CAUTION: card payments are estimates"]],
    },
    "Bill Schedule": {
      headers: [
        "ID",
        "Due date",
        "Bill",
        "Payment account",
        "Expected ($)",
        "Status",
        "Confirmed amount ($)",
        "Cash outflow ($)",
        "Source",
        "Notes / date confidence",
        "Month",
      ],
      rows: [
        scheduleRow("MORT", "2026-11-01"), // before the forecast start: not compared
        scheduleRow("MORT", "2026-12-01"),
        scheduleRow("MORT", "2027-01-01"),
        ...weekly("DAYCARE", "2026-11-06", "2027-01-29"),
        scheduleRow("INS", "2026-12-15"),
        scheduleRow("CITI", "2026-11-20", 0),
        scheduleRow("CITI", "2026-12-20"),
        scheduleRow("CITI", "2027-01-20"),
        scheduleRow("PNCCARD", "2026-11-25", 0),
        scheduleRow("PNCCARD", "2026-12-25"),
        scheduleRow("PNCCARD", "2027-01-25"),
      ],
    },
    // What the engine gives for these days with the standard choices (both $0 card rows skipped).
    "Cash Flow": {
      headers: [
        "Date",
        "Drake pay",
        "Alexis pay",
        "Ally Spend deposits",
        "PNC deposits",
        "Alexis checking deposits",
        "Savings deposits",
        "Spend bills",
        "PNC bills",
        "Spend projection",
        "PNC projection",
        "Alexis projection",
        "Savings projection",
        "Spend safety flag",
        "Month",
        "Notes",
      ],
      rows: [
        cashFlowRow("2026-11-02", 2000, 800),
        cashFlowRow("2026-11-06", 2350, 900),
        cashFlowRow("2026-11-13", 2700, 1000),
        cashFlowRow("2026-11-15", 3450, 1000),
        cashFlowRow("2026-11-20", 3800, 1100),
      ],
    },
  };
}

/** The answers that settle every question the standard workbook raises. */
export const STANDARD_CHOICES = {
  cards: { STREAM: "AMEX", GYM: "CITI" },
  pays: { CITI: "CITI", PNCCARD: "PNCCC" },
  schedule: { "CITI-20261120": "skip", "PNCCARD-20261125": "skip" },
};

const isFormula = (cell: FixtureCell): cell is { formula: string; result?: number | string | Date } =>
  cell !== null && typeof cell === "object" && !(cell instanceof Date);

export async function buildWorkbook(spec: WorkbookSpec): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  for (const [name, sheet] of Object.entries(spec)) {
    const ws = workbook.addWorksheet(name);
    ws.getCell(1, 1).value = `${name} (synthetic)`;
    sheet.headers.forEach((header, i) => (ws.getCell(3, i + 1).value = header));
    sheet.rows.forEach((row, r) =>
      row.forEach((value, c) => {
        if (value === null) return;
        const cell = ws.getCell(4 + r, c + 1);
        cell.value = isFormula(value) ? { formula: value.formula, result: value.result } : value;
        const isDate = value instanceof Date || (isFormula(value) && value.result instanceof Date);
        if (isDate) cell.numFmt = "yyyy-mm-dd";
      }),
    );
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
