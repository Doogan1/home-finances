import { choicesInput } from "@/features/import/choices";
import { parseWorkbook, type ParsedWorkbook } from "@/features/import/parse";
import { planImport, type ImportPlan } from "@/features/import/plan";
import { readSheets } from "@/features/import/workbook";
import type { IsoDate } from "@/lib/calendar-date";
import { STANDARD_CHOICES, buildWorkbook, standardWorkbook, type WorkbookSpec } from "./workbook-fixture";

/** The standard synthetic workbook, changed by `change`, read and parsed. */
export async function parsedWorkbook(change: (spec: WorkbookSpec) => void = () => {}): Promise<ParsedWorkbook> {
  const spec = standardWorkbook();
  change(spec);
  return parseWorkbook(await readSheets(await buildWorkbook(spec)));
}

/** The plan for a parsed workbook; the standard answers unless others are given. */
export function planned(workbook: ParsedWorkbook, choices: unknown = STANDARD_CHOICES, today: IsoDate | null = null): ImportPlan {
  return planImport(workbook, choicesInput.parse(choices), today);
}
