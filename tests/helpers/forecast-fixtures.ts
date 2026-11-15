import type { ForecastOverride, ForecastRule } from "@/features/forecast/occurrences";
import type { StoredVersion } from "@/features/rules/versions";

/** Builders for the forecast's unit tests. Every figure is made up. */

/** Monthly on the 1st from Nov 1, 2026, $100, all from "spend". */
export const version = (patch: Partial<StoredVersion> = {}): StoredVersion => ({
  id: "v1",
  effectiveFrom: "2026-11-01",
  effectiveTo: null,
  amount: "100",
  recurrence: "MONTHLY",
  interval: 1,
  anchorDate: "2026-11-01",
  dayOfMonth: 1,
  secondDay: null,
  note: null,
  allocations: [{ accountId: "spend", mode: "REMAINDER", value: null }],
  ...patch,
});

export const rule = (patch: Partial<ForecastRule> = {}): ForecastRule => ({
  id: "r1",
  name: "Mortgage",
  kind: "BILL",
  versions: [version()],
  ...patch,
});

export const edit = (patch: Partial<ForecastOverride> & { scheduledOn: string }): ForecastOverride => ({
  ruleId: "r1",
  status: "PLANNED",
  confirmedAmount: null,
  movedTo: null,
  ...patch,
});
