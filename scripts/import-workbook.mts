import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AccountInputError } from "@/features/accounts/manual";
import { formatReport } from "@/features/import/report";
import { ImportRefused, applyPlan, importWorkbook, type ImportRefusal } from "@/features/import/service";
import { RuleInputError } from "@/features/rules/service";
import { getDb } from "@/lib/db";
import { promptLine } from "./lib/prompt.mjs";
import { UserSetupError } from "./lib/users.mjs";

/**
 * The one-time workbook import (build step 4 of the bills and forecast design).
 *
 *   docker compose exec app npm run import:workbook -- imports/<file>.xlsx                 -> dry run: writes nothing
 *   docker compose exec app npm run import:workbook -- imports/<file>.xlsx --apply         -> writes it all, in one transaction
 *   ... [--choices imports/choices.json] [--household <id>]
 *
 * It reads only files inside imports/ (ignored by git and by the Docker build)
 * and contacts nothing. The answers to its questions are read from
 * imports/choices.json unless --choices names another file there.
 */

const USAGE = "Usage: import:workbook -- imports/<workbook>.xlsx [--apply] [--choices imports/<file>.json] [--household <id>]";

const REFUSALS: Record<ImportRefusal, string> = {
  no_household: "No household exists yet. Run auth:bootstrap first.",
  several_households: "More than one household exists. Name one with --household <id>.",
  household_not_found: "No household has that id.",
  unsettled: "Nothing was written: answer every question and fix every problem listed above, then run again.",
  time_zone_required: "Nothing was written: set the household's time zone first (Home asks for it), then run again.",
  already_imported: "Nothing was written: this household already has imported accounts or rules, and the import runs only once.",
  unreadable_workbook: "The workbook could not be read; check it is an .xlsx file.",
};

function parseArgs(args: string[]) {
  const options: { file?: string; apply: boolean; choices?: string; household?: string } = { apply: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--choices" && args[i + 1]) options.choices = args[++i];
    else if (arg === "--household" && args[i + 1]) options.household = args[++i];
    else if (!arg.startsWith("--") && options.file === undefined) options.file = arg;
    else throw new UserSetupError(USAGE);
  }
  if (options.file === undefined) throw new UserSetupError(USAGE);
  return options as typeof options & { file: string };
}

/** The workbook holds real finances, so it is read only from imports/, which git and Docker ignore. */
function insideImports(file: string): string {
  const imports = path.resolve("imports");
  const resolved = path.resolve(file);
  if (path.dirname(resolved) !== imports) throw new UserSetupError(`Keep the file directly in imports/ (it is ignored by git and the Docker build): ${file}`);
  if (!existsSync(resolved)) throw new UserSetupError(`No such file: ${file}`);
  return resolved;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workbookPath = insideImports(options.file);
  const defaultChoices = path.resolve("imports", "choices.json");
  const choicesPath = options.choices ? insideImports(options.choices) : existsSync(defaultChoices) ? defaultChoices : null;

  console.log(options.apply ? "Workbook import: APPLY" : "Workbook import: dry run (nothing will be written)");
  console.log(`Workbook: ${path.relative(process.cwd(), workbookPath)}`);
  console.log(`Answers:  ${choicesPath ? path.relative(process.cwd(), choicesPath) : "none (imports/choices.json does not exist)"}`);
  console.log("Before --apply, back up the database: run `npm run backup` on the host.");

  const db = getDb();
  try {
    const outcome = await importWorkbook(db, {
      workbook: new Uint8Array(readFileSync(workbookPath)),
      choicesText: choicesPath ? readFileSync(choicesPath, "utf8") : null,
      apply: false,
      householdId: options.household,
    });
    console.log(`Household: ${outcome.household.name}`);
    for (const line of formatReport(outcome.plan, outcome.schedule, outcome.cashFlow)) console.log(line);
    if (outcome.alreadyImported) console.log("\nThis household already has imported rows, so --apply will refuse.");
    const open = outcome.plan.questions.length + outcome.plan.problems.length;
    if (!options.apply) {
      console.log(open > 0 ? `\n${open} question(s) and problem(s) to settle before --apply.` : "\nReady: back up, then run again with --apply.");
      return;
    }
    if (open > 0) throw new ImportRefused("unsettled");
    // Refuse before the backup question; applyPlan checks again inside the lock.
    if (outcome.alreadyImported) throw new ImportRefused("already_imported");
    const answer = await promptLine("\nHave you made a backup since your last change? Type yes to write the import: ");
    if (answer !== "yes") throw new UserSetupError("Not applied. Run `npm run backup` on the host, then run again with --apply");
    // The plan just printed is exactly what is written.
    const a = await applyPlan(db, outcome.household.id, outcome.plan);
    console.log(
      `\nImported: ${a.accounts} accounts, ${a.snapshots} balances, ${a.rules} rules (${a.versions} versions), ${a.overrides} per-date edits.`,
    );
    console.log("Review every imported rule on Bills & income, and the forecast on Home.");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Messages here are written to be shown; anything unexpected gets a generic line.
  if (error instanceof UserSetupError) console.error(`Error: ${error.message}`);
  else if (error instanceof ImportRefused) console.error(`Refused: ${REFUSALS[error.code]}`);
  else if (error instanceof RuleInputError || error instanceof AccountInputError) console.error(`Refused (${error.code}); nothing was written.`);
  else if (error instanceof Error && error.message.startsWith("This command needs")) console.error(error.message);
  else console.error("Error: the import failed and nothing was written. Check that the database is running and migrated.");
  process.exitCode = 1;
});
