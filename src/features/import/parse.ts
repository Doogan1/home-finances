import { parseIsoDate, toIsoDate, type IsoDate } from "@/lib/calendar-date";
import { fromCents, toCents } from "@/lib/cents";
import { parseMoney } from "@/lib/money";
import { cellAt, type Cell, type Grid, type Sheets } from "./workbook";

/**
 * Turns the workbook's sheets into typed rows. Every sheet has its title in
 * row 1, headers in row 3 and data from row 4; a table ends at the first row
 * with nothing in column A. Settings are found by the label in column A, never
 * by row number. A cell that cannot be read becomes a problem naming its sheet
 * and row, and the row is left out; nothing is guessed.
 */

export const SHEETS = {
  accounts: "Accounts",
  history: "Balance History",
  settings: "Settings",
  bills: "Bills",
  schedule: "Bill Schedule",
  cashFlow: "Cash Flow",
} as const;
const FIRST_ROW = 4;

export class CellProblem extends Error {}

const problem = (message: string): never => {
  throw new CellProblem(message);
};

/** Excel's day 0 is 1899-12-30; 25569 is 1970-01-01. */
const EXCEL_EPOCH_OFFSET = 25569;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Excel's last date, 9999-12-31, as a serial. */
const LAST_SERIAL = 2958465;

/**
 * The calendar date of a UTC instant. Every path that turns a date cell into an
 * IsoDate goes through here, so a value that is not a date in 1900 to 9999 (an
 * invalid Date, or a number that was never a serial) is a problem, not a crash
 * or a made-up date.
 */
function calendarDay(time: number, what: string): IsoDate {
  const date = new Date(time);
  if (!Number.isFinite(time) || date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 9999) problem(`${what} is not a date`);
  return toIsoDate(date);
}

export function textOf(cell: Cell): string | null {
  if (cell === null) return null;
  if (cell instanceof Date) return calendarDay(cell.getTime(), "A cell");
  const text = String(cell).replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

const requiredText = (cell: Cell, what: string): string => textOf(cell) ?? problem(`${what} is blank`);

/** An amount as a canonical decimal string with two places ("1840.91", "-12.40"), or null when blank. */
export function moneyOf(cell: Cell, what: string): string | null {
  if (cell === null || (typeof cell === "string" && cell.trim() === "")) return null;
  if (typeof cell === "number") {
    const cents = Math.round(cell * 100);
    // Excel keeps amounts as binary fractions, so 1840.91 is 1840.9099999999999.
    if (!Number.isFinite(cell) || Math.abs(cell * 100 - cents) > 1e-6) problem(`${what} has more than two decimal places`);
    return fromCents(BigInt(cents));
  }
  if (typeof cell === "string") {
    const parsed = parseMoney(cell, { allowNegative: true });
    if (parsed !== null) return fromCents(toCents(parsed));
  }
  return problem(`${what} is not an amount`);
}

const requiredMoney = (cell: Cell, what: string): string => moneyOf(cell, what) ?? problem(`${what} is blank`);

/**
 * A Cash Flow projection, rounded to the cent. The sheet splits pay by percentage
 * without rounding (70% of 1926.94 is 1348.858), so its running balances carry
 * fractions of a cent. They are only compared, never imported, so they are rounded
 * rather than refused.
 */
export function projectionOf(cell: Cell, what: string): string | null {
  if (typeof cell === "number" && Number.isFinite(cell)) return fromCents(BigInt(Math.round(cell * 100)));
  return moneyOf(cell, what);
}

/** A calendar date from a date cell (its UTC day, which is how Excel dates are read), a date serial or "YYYY-MM-DD". */
export function dateOf(cell: Cell, what: string): IsoDate | null {
  if (cell === null || (typeof cell === "string" && cell.trim() === "")) return null;
  if (cell instanceof Date) return calendarDay(cell.getTime(), what);
  if (typeof cell === "number") {
    if (!(cell >= 1 && cell <= LAST_SERIAL)) problem(`${what} is not a date`);
    return calendarDay((Math.floor(cell) - EXCEL_EPOCH_OFFSET) * DAY_MS, what);
  }
  if (typeof cell === "string" && parseIsoDate(cell.trim())) return cell.trim();
  return problem(`${what} is not a date`);
}

const requiredDate = (cell: Cell, what: string): IsoDate => dateOf(cell, what) ?? problem(`${what} is blank`);

/** A day of the month, 1 to 31, or null when blank. */
export function dayOf(cell: Cell, what: string): number | null {
  if (cell === null || (typeof cell === "string" && cell.trim() === "")) return null;
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) problem(`${what} is not a day of the month (1 to 31)`);
    return cell.getUTCDate();
  }
  const value = typeof cell === "string" ? Number(cell.trim()) : cell;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 31) return value;
  return problem(`${what} is not a day of the month (1 to 31)`);
}

/**
 * A share of pay as a percentage string with at most two decimals ("60",
 * "12.5"). Excel stores a percent-formatted cell as a fraction (60% is 0.6),
 * so a value from 0 to 1 is a fraction and 1 means 100%; a value above 1, up
 * to 100, was typed as a percentage. "60%" as text is a percentage.
 */
export function shareOf(cell: Cell, what: string): string | null {
  if (cell === null || (typeof cell === "string" && cell.trim() === "")) return null;
  let percent: number;
  if (typeof cell === "number") percent = cell <= 1 ? cell * 100 : cell;
  else if (typeof cell === "string" && /^\d+(\.\d+)?\s*%$/.test(cell.trim())) percent = Number.parseFloat(cell);
  else if (typeof cell === "string" && /^\d+(\.\d+)?$/.test(cell.trim())) {
    const value = Number(cell.trim());
    percent = value <= 1 ? value * 100 : value;
  } else return problem(`${what} is not a share`);
  if (!(percent >= 0 && percent <= 100)) problem(`${what} is not between 0% and 100%`);
  const text = percent.toFixed(4).replace(/\.?0+$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) problem(`${what} has more than two decimal places as a percentage`);
  return text;
}

// ---------------------------------------------------------------------------

export type AccountType = "Checking" | "Savings" | "Credit card";
export type WorkbookAccount = {
  row: number;
  id: string;
  name: string;
  type: AccountType;
  owner: string | null;
  balance: string | null;
  balanceDate: IsoDate | null;
};
export type HistoryEntry = { row: number; snapshotId: string | null; accountId: string; asOfDate: IsoDate; balance: string };
export type DrakePay = {
  weeklyNet: string;
  firstPayday: IsoDate;
  spendShare: string;
  pncShare: string;
  savingsShare: string | null;
  changeFrom: IsoDate | null;
  changedNet: string | null;
  notes: string | null;
};
export type AlexisPay = {
  semiMonthlyNet: string;
  payDay1: number;
  payDay2: number;
  spendShare: string;
  personalShare: string;
  savingsShare: string | null;
  changeFrom: IsoDate | null;
  changedNet: string | null;
  notes: string | null;
};
export type Settings = { forecastStart: IsoDate; cushion: string | null; drake: DrakePay; alexis: AlexisPay };
export type Frequency = "Monthly" | "Weekly" | "Semiannual";
export type Treatment = "Direct" | "Included in card payment";
export type WorkbookBill = {
  row: number;
  id: string;
  name: string;
  category: string | null;
  amount: string;
  frequency: Frequency;
  paymentAccount: string | null;
  treatment: Treatment;
  dueDay: number | null;
  method: string | null;
  notes: string | null;
};
export type ScheduleEntry = {
  row: number;
  id: string;
  billId: string;
  dueDate: IsoDate;
  expected: string;
  status: string | null;
  confirmed: string | null;
};
export type CashFlowEntry = { row: number; date: IsoDate; spend: string | null; pnc: string | null };
export type ParsedWorkbook = {
  accounts: WorkbookAccount[];
  history: HistoryEntry[];
  settings: Settings | null;
  bills: WorkbookBill[];
  schedule: ScheduleEntry[];
  /** Empty when the workbook has no Cash Flow sheet. */
  cashFlow: CashFlowEntry[];
  problems: string[];
};

const ACCOUNT_TYPES: Record<string, AccountType> = { checking: "Checking", savings: "Savings", "credit card": "Credit card" };
const FREQUENCIES: Record<string, Frequency> = { monthly: "Monthly", weekly: "Weekly", semiannual: "Semiannual" };
const TREATMENTS: Record<string, Treatment> = { direct: "Direct", "included in card payment": "Included in card payment" };

const pick = <T>(table: Record<string, T>, cell: Cell, what: string): T =>
  table[(textOf(cell) ?? "").toLowerCase()] ?? problem(`${what} "${textOf(cell) ?? ""}" is not one of ${Object.values(table).join(", ")}`);

/** Each data row (from row 4 to the first with nothing in column A), read by `read`; unreadable rows become problems. */
function table<T>(grid: Grid, sheet: string, problems: string[], read: (cell: (column: number) => Cell, row: number) => T): T[] {
  const rows: T[] = [];
  for (let row = FIRST_ROW; ; row++) {
    let id: string | null;
    try {
      id = textOf(cellAt(grid, row, 1));
    } catch (error) {
      if (!(error instanceof CellProblem)) throw error;
      // Column A is unreadable, so the row is not blank: it is a problem, and the table goes on.
      problems.push(`${sheet} row ${row}: ${error.message}`);
      continue;
    }
    if (id === null) break;
    try {
      rows.push(read((column) => cellAt(grid, row, column), row));
    } catch (error) {
      if (!(error instanceof CellProblem)) throw error;
      problems.push(`${sheet} row ${row}: ${error.message}`);
    }
  }
  return rows;
}

function readAccount(cell: (column: number) => Cell, row: number): WorkbookAccount {
  const balance = moneyOf(cell(5), "Latest balance");
  const balanceDate = dateOf(cell(6), "Snapshot date");
  if (balance !== null && balanceDate === null) problem("Latest balance has no snapshot date");
  return {
    row,
    id: requiredText(cell(1), "Account ID"),
    name: requiredText(cell(2), "Account"),
    type: pick(ACCOUNT_TYPES, cell(3), "Type"),
    owner: textOf(cell(4)),
    balance,
    balanceDate: balance === null ? null : balanceDate,
  };
}

function readHistory(cell: (column: number) => Cell, row: number): HistoryEntry {
  return {
    row,
    snapshotId: textOf(cell(1)),
    accountId: requiredText(cell(2), "Account ID"),
    asOfDate: requiredDate(cell(3), "As-of date"),
    balance: requiredMoney(cell(4), "Balance"),
  };
}

function readBill(cell: (column: number) => Cell, row: number): WorkbookBill {
  return {
    row,
    id: requiredText(cell(1), "Bill ID"),
    name: requiredText(cell(2), "Obligation"),
    category: textOf(cell(3)),
    amount: requiredMoney(cell(4), "Amount"),
    frequency: pick(FREQUENCIES, cell(5), "Frequency"),
    paymentAccount: textOf(cell(6)),
    treatment: pick(TREATMENTS, cell(7), "Cash treatment"),
    dueDay: dayOf(cell(8), "Due date / day"),
    method: textOf(cell(9)),
    notes: textOf(cell(10)),
  };
}

function readSchedule(cell: (column: number) => Cell, row: number): ScheduleEntry {
  const id = requiredText(cell(1), "ID");
  const dash = id.lastIndexOf("-");
  if (dash <= 0) problem(`ID "${id}" is not <bill id>-<date>`);
  return {
    row,
    id,
    billId: id.slice(0, dash),
    dueDate: requiredDate(cell(2), "Due date"),
    expected: moneyOf(cell(5), "Expected") ?? problem("Expected has no saved amount"),
    status: textOf(cell(6)),
    confirmed: moneyOf(cell(7), "Confirmed amount"),
  };
}

function readCashFlow(cell: (column: number) => Cell, row: number): CashFlowEntry {
  return {
    row,
    date: requiredDate(cell(1), "Date"),
    spend: projectionOf(cell(10), "Spend projection"),
    pnc: projectionOf(cell(11), "PNC projection"),
  };
}

const normalLabel = (cell: Cell) => (textOf(cell) ?? "").toLowerCase();

type SettingRow = { value: Cell; notes: string | null; row: number };

/** The Settings row whose label starts with `label` (case and spacing ignored); exactly one must. */
function setting(grid: Grid, label: string): SettingRow | null {
  const key = label.toLowerCase();
  const matches: SettingRow[] = [];
  for (let row = FIRST_ROW; row <= grid.length; row++) {
    if (normalLabel(cellAt(grid, row, 1)).startsWith(key)) {
      matches.push({ value: cellAt(grid, row, 2), notes: textOf(cellAt(grid, row, 3)), row });
    }
  }
  if (matches.length > 1) problem(`more than one row is labelled "${label}" (rows ${matches.map((m) => m.row).join(", ")})`);
  return matches[0] ?? null;
}

function readSettings(grid: Grid, problems: string[]): Settings | null {
  const before = problems.length;
  const notes: Record<"drake" | "alexis", string[]> = { drake: [], alexis: [] };
  const read = <T>(label: string, convert: (cell: Cell, what: string) => T | null, required: boolean): T | null => {
    try {
      const found = setting(grid, label);
      const earner = label.startsWith("Drake") ? "drake" : label.startsWith("Alexis") ? "alexis" : null;
      if (found?.notes && earner) notes[earner].push(`${label}: ${found.notes}`);
      const value = found ? convert(found.value, label) : null;
      if (value === null && required) problem(found ? `"${label}" is blank` : `no row is labelled "${label}"`);
      return value;
    } catch (error) {
      if (!(error instanceof CellProblem)) throw error;
      problems.push(`Settings: ${error.message}`);
      return null;
    }
  };
  const forecastStart = read("Forecast start", dateOf, true);
  const cushion = read("Spend minimum cushion", moneyOf, false);
  const drake = {
    weeklyNet: read("Drake net weekly", moneyOf, true),
    firstPayday: read("Drake first payday", dateOf, true),
    spendShare: read("Drake Ally Spend share", shareOf, true),
    pncShare: read("Drake PNC share", shareOf, true),
    savingsShare: read("Drake savings share", shareOf, false),
    changeFrom: read("Drake changed pay effective", dateOf, false),
    changedNet: read("Drake changed weekly net", moneyOf, false),
  };
  const alexis = {
    semiMonthlyNet: read("Alexis net semi-monthly", moneyOf, true),
    payDay1: read("Alexis pay date 1", dayOf, true),
    payDay2: read("Alexis pay date 2", dayOf, true),
    spendShare: read("Alexis Ally Spend share", shareOf, true),
    personalShare: read("Alexis personal share", shareOf, true),
    savingsShare: read("Alexis savings share", shareOf, false),
    changeFrom: read("Alexis changed pay effective", dateOf, false),
    changedNet: read("Alexis changed semi-monthly net", moneyOf, false),
  };
  if (problems.length > before) return null;
  // Every required value was read, so none of these is null.
  return {
    forecastStart: forecastStart!,
    cushion,
    drake: { ...(drake as DrakePay), notes: notes.drake.join("; ") || null },
    alexis: { ...(alexis as AlexisPay), notes: notes.alexis.join("; ") || null },
  };
}

/** Two rows with the same ID, or the same bill and date, are one occurrence: the first is used, the repeat is a problem. */
function firstOfEach(rows: ScheduleEntry[], problems: string[]): ScheduleEntry[] {
  const seen = new Map<string, number>();
  return rows.filter((entry) => {
    const first = seen.get(entry.id) ?? seen.get(`${entry.billId}|${entry.dueDate}`);
    if (first !== undefined) {
      problems.push(`Bill Schedule row ${entry.row}: same bill and date as row ${first}`);
      return false;
    }
    seen.set(entry.id, entry.row);
    seen.set(`${entry.billId}|${entry.dueDate}`, entry.row);
    return true;
  });
}

export function parseWorkbook(sheets: Sheets): ParsedWorkbook {
  const problems: string[] = [];
  const sheet = (name: string, required: boolean): Grid => {
    const grid = sheets.get(name);
    if (!grid && required) problems.push(`The workbook has no "${name}" sheet`);
    return grid ?? [];
  };
  const accounts = table(sheet(SHEETS.accounts, true), SHEETS.accounts, problems, readAccount);
  const history = table(sheet(SHEETS.history, false), SHEETS.history, problems, readHistory);
  const settingsGrid = sheet(SHEETS.settings, true);
  const settings = sheets.has(SHEETS.settings) ? readSettings(settingsGrid, problems) : null;
  const bills = table(sheet(SHEETS.bills, true), SHEETS.bills, problems, readBill);
  const schedule = firstOfEach(table(sheet(SHEETS.schedule, true), SHEETS.schedule, problems, readSchedule), problems);
  const cashFlow = table(sheet(SHEETS.cashFlow, false), SHEETS.cashFlow, problems, readCashFlow);
  return { accounts, history, settings, bills, schedule, cashFlow, problems };
}
