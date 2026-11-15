import { ACCOUNT_KINDS } from "@/features/accounts/input";
import { buildForecast, type ForecastInput } from "@/features/forecast/engine";
import type { LatestSnapshot } from "@/features/forecast/snapshots";
import { daysBetween, type IsoDate } from "@/lib/calendar-date";
import { fromCents, toCents } from "@/lib/cents";
import { SplitError, splitAmount } from "@/features/rules/splits";
import type { CashFlowEntry } from "./parse";
import { LAYOUT, type ImportPlan, type PlannedRule } from "./plan";

/**
 * The Cash Flow sheet is not copied either. Its saved Spend and PNC
 * projections are compared with the forecast engine run on the planned import
 * (no database: the engine is pure), with "today" at the forecast start.
 * Account and rule ids in that input are the workbook's ids.
 */

/** A rule the engine can run: every version has a valid split (an unanswered card question leaves none). */
export function forecastable(rule: PlannedRule): boolean {
  return rule.versions.every((v) => {
    try {
      splitAmount(toCents(v.amount), v.allocations.map((a) => ({ accountId: a.accountRef, mode: a.mode, value: a.value })));
      return true;
    } catch (error) {
      if (error instanceof SplitError) return false;
      throw error;
    }
  });
}

export function forecastInputFor(plan: ImportPlan, today: IsoDate, days: number): ForecastInput {
  const snapshots = new Map<string, LatestSnapshot>();
  for (const s of plan.snapshots) {
    const best = snapshots.get(s.accountRef);
    if (!best || s.asOfDate > best.date) {
      snapshots.set(s.accountRef, { accountId: s.accountRef, date: s.asOfDate, observedAt: new Date(`${s.asOfDate}T12:00:00Z`), balance: s.balance });
    }
  }
  return {
    today,
    days,
    accounts: plan.accounts.map((a) => {
      const kind = ACCOUNT_KINDS[a.kind];
      return {
        id: a.ref,
        name: a.name,
        type: kind.type,
        subtype: kind.subtype,
        // As the account service sets it: on for depository accounts, off for cards.
        includeInForecast: kind.type === "depository",
        cushion: a.cushion,
        archived: false,
        active: true,
      };
    }),
    snapshots,
    rules: plan.rules.filter(forecastable).map((r) => ({
      id: r.ref,
      name: r.name,
      kind: r.kind,
      versions: r.versions.map((v, i) => ({
        ...v,
        id: `${r.ref}#${i + 1}`,
        allocations: v.allocations.map((a) => ({ accountId: a.accountRef, mode: a.mode, value: a.value })),
      })),
    })),
    overrides: plan.overrides.map((o) => ({ ruleId: o.ruleRef, scheduledOn: o.scheduledOn, status: o.status, confirmedAmount: o.confirmedAmount, movedTo: null })),
  };
}

export type CashFlowDifference = { date: IsoDate; accountRef: string; workbook: string; app: string };
export type CashFlowComparison = { compared: number; differences: CashFlowDifference[]; notCompared: string[] };

export function compareCashFlow(plan: ImportPlan, cashFlow: readonly CashFlowEntry[]): CashFlowComparison {
  const result: CashFlowComparison = { compared: 0, differences: [], notCompared: [] };
  const start = plan.forecastStart;
  const saved = cashFlow.filter((row) => row.spend !== null || row.pnc !== null);
  if (start === null || saved.length === 0) {
    if (start !== null) result.notCompared.push("The Cash Flow sheet has no saved projections");
    return result;
  }
  const last = saved.reduce((max, row) => (row.date > max ? row.date : max), saved[0].date);
  if (last < start) {
    result.notCompared.push("Every Cash Flow row is before the forecast start");
    return result;
  }
  const leftOut = plan.rules.filter((r) => !forecastable(r)).map((r) => r.ref);
  if (leftOut.length > 0) result.notCompared.push(`Left out of the forecast until settled: ${leftOut.join(", ")}`);
  const forecast = buildForecast(forecastInputFor(plan, start, daysBetween(start, last) + 1));
  for (const [ref, column] of [[LAYOUT.spend, "spend"], [LAYOUT.pnc, "pnc"]] as const) {
    const account = forecast.accounts.find((a) => a.account.id === ref);
    if (!account || account.kind !== "forecast") {
      result.notCompared.push(`${ref} has no balance to start from, so its projection is not compared`);
      continue;
    }
    const closing = new Map(account.days.map((d) => [d.date, d.closing]));
    for (const row of saved) {
      const value = row[column];
      const app = closing.get(row.date);
      if (value === null || app === undefined) continue;
      result.compared++;
      if (app !== toCents(value)) result.differences.push({ date: row.date, accountRef: ref, workbook: value, app: fromCents(app) });
    }
  }
  return result;
}
