import type { CashFlowComparison } from "./cash-flow";
import type { ImportPlan, PlannedVersion } from "./plan";
import type { ScheduleComparison } from "./schedule";

/**
 * The importer's printout: everything it would create (every rule, for
 * review), both checks, and every note, question and problem. Plain lines,
 * so the command prints them and tests read them.
 */

const LIMIT = 25;

function capped<T>(items: readonly T[], line: (item: T) => string): string[] {
  const lines = items.slice(0, LIMIT).map((item) => `  ${line(item)}`);
  if (items.length > LIMIT) lines.push(`  ...and ${items.length - LIMIT} more`);
  return lines;
}

export function describeVersion(v: PlannedVersion): string {
  const every = (n: number, unit: string) => (n === 1 ? `every ${unit}` : `every ${n} ${unit}s`);
  const schedule =
    v.recurrence === "WEEKLY"
      ? every(v.interval, "week")
      : v.recurrence === "MONTHLY"
        ? `${every(v.interval, "month")} on day ${v.dayOfMonth}`
        : v.recurrence === "TWICE_MONTHLY"
          ? `on days ${v.dayOfMonth} and ${v.secondDay} each month`
          : "once";
  const split = v.allocations
    .map((a) => (a.mode === "PERCENT" ? `${a.accountRef} ${a.value}%` : a.mode === "FIXED" ? `${a.accountRef} ${a.value}` : `${a.accountRef} rest`))
    .join(", ");
  const until = v.effectiveTo === null ? "" : ` to ${v.effectiveTo}`;
  return `${v.amount} ${schedule}, first ${v.anchorDate} (from ${v.effectiveFrom}${until}): ${split}`;
}

export function formatReport(plan: ImportPlan, schedule: ScheduleComparison | null, cashFlow: CashFlowComparison | null): string[] {
  const lines: string[] = [];
  const section = (title: string, body: string[]) => lines.push("", title, ...(body.length > 0 ? body : ["  (none)"]));

  lines.push(`Forecast start: ${plan.forecastStart ?? "(unknown)"}`);
  section(
    `Accounts to create (${plan.accounts.length})`,
    plan.accounts.map((a) => `  ${a.ref}: ${a.name}, ${a.kind}${a.ownerLabel ? `, owner ${a.ownerLabel}` : ""}${a.cushion ? `, cushion ${a.cushion}` : ""}`),
  );
  section(`Balances to record (${plan.snapshots.length})`, plan.snapshots.map((s) => `  ${s.accountRef} on ${s.asOfDate}: ${s.balance}`));
  section(
    `Rules to create, for review (${plan.rules.length})`,
    plan.rules.flatMap((r) => [
      `  ${r.ref}: ${r.name} (${r.kind === "INCOME" ? "income" : "bill"}${r.paysAccountRef ? `, pays ${r.paysAccountRef}` : ""})`,
      ...r.versions.map((v) => `    ${describeVersion(v)}`),
    ]),
  );
  section(
    `Per-date edits to record (${plan.overrides.length})`,
    plan.overrides.map((o) => `  ${o.ruleRef} on ${o.scheduledOn}: ${o.status === "SKIPPED" ? "skipped" : `confirmed at ${o.confirmedAmount}`}`),
  );

  if (schedule) {
    const window = schedule.window ? `${schedule.window.from} to ${schedule.window.to}` : "no rows on or after the forecast start";
    const body = [
      ...capped(schedule.missing, (m) => `${m.id}: the rule has no occurrence on ${m.dueDate}`),
      ...capped(schedule.extra, (e) => `${e.ruleRef}: the rule has ${e.date}, the schedule does not`),
      ...capped(schedule.amounts, (a) => `${a.entry.id}: the schedule has ${a.entry.expected}, the rule ${a.ruleAmount} (a question)`),
      ...capped(schedule.unknownBill, (u) => `${u.id}: no bill ${u.billId} in the Bills sheet`),
      ...capped(schedule.noRows, (ref) => `${ref}: paid directly but has no schedule rows`),
      ...capped(schedule.stateNotCopied, (s) => `${s.id}: its status or confirmed amount is not copied`),
    ];
    section(`Bill Schedule check, ${window} (${schedule.beforeStart} earlier rows not compared)`, body);
  }
  if (cashFlow) {
    section(`Cash Flow check: ${cashFlow.compared} end-of-day balances compared, ${cashFlow.differences.length} differ`, [
      ...cashFlow.notCompared.map((n) => `  ${n}`),
      ...capped(cashFlow.differences, (d) => `${d.date} ${d.accountRef}: the workbook has ${d.workbook}, the app ${d.app}`),
    ]);
  }
  section(`Notes (${plan.notes.length})`, plan.notes.map((n) => `  ${n}`));
  section(
    `Questions to answer in imports/choices.json (${plan.questions.length})`,
    plan.questions.map((q) => `  ${q.section}.${q.key}: ${q.prompt} [${q.options.join(" | ")}]`),
  );
  section(`Problems to fix in the workbook or choices.json (${plan.problems.length})`, plan.problems.map((p) => `  ${p}`));
  return lines;
}
