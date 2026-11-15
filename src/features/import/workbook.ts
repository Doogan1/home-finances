import ExcelJS from "exceljs";

/**
 * Reads the workbook's sheets into plain grids of values. A formula cell reads
 * as the result Excel saved with it, so derived columns read as the workbook
 * last showed them; a formula saved without a result, or with an error, reads
 * as null. It takes the file's bytes, never a path, and contacts nothing.
 */

export type Cell = string | number | boolean | Date | null;
/** `rows[0]` is sheet row 1 and `rows[r][0]` is column A; missing cells are null. */
export type Grid = Cell[][];
export type Sheets = ReadonlyMap<string, Grid>;

export function plainValue(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value instanceof Date) return value;
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("hyperlink" in value) return value.text;
  if ("formula" in value || "sharedFormula" in value) return value.result === undefined ? null : plainValue(value.result);
  return null; // an error value such as #N/A
}

function toGrid(sheet: ExcelJS.Worksheet): Grid {
  const rows: Grid = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: Cell[] = [];
    row.eachCell({ includeEmpty: false }, (cell, column) => {
      cells[column - 1] = plainValue(cell.value);
    });
    rows[rowNumber - 1] = Array.from(cells, (cell) => cell ?? null);
  });
  return Array.from(rows, (row) => row ?? []);
}

export async function readSheets(bytes: ArrayBuffer | Uint8Array): Promise<Sheets> {
  const workbook = new ExcelJS.Workbook();
  // exceljs's typings want a Node Buffer; it reads any byte array.
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheets = new Map<string, Grid>();
  workbook.eachSheet((sheet) => sheets.set(sheet.name, toGrid(sheet)));
  return sheets;
}

/** The value at a 1-based row and column, or null. */
export function cellAt(grid: Grid, row: number, column: number): Cell {
  return grid[row - 1]?.[column - 1] ?? null;
}
