import { FORECAST_DAYS, type ForecastAccount, type ForecastInput } from "@/features/forecast/engine";
import type { LatestSnapshot } from "@/features/forecast/snapshots";
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

export const TODAY = "2026-11-14";

export const account = (id: string, patch: Partial<ForecastAccount> = {}): ForecastAccount => ({
  id,
  name: id,
  type: "depository",
  subtype: "checking",
  includeInForecast: true,
  cushion: null,
  archived: false,
  active: true,
  ...patch,
});

export const snapshot = (accountId: string, date: string, balance: string): LatestSnapshot => ({
  accountId,
  date,
  observedAt: new Date(`${date}T20:00:00Z`),
  balance,
});

export const ACCOUNTS = [
  account("spend", { name: "Ally Spend", cushion: "1500" }),
  account("savings", { name: "Ally Savings", subtype: "savings" }),
  account("amex", { name: "Amex", type: "credit", subtype: "credit card" }),
];

/** Every Friday from Nov 6, 2026: $1,000, 70% to Ally Spend and the rest to Ally Savings. */
export const PAYCHECK = rule({
  id: "pay",
  name: "Paycheck",
  kind: "INCOME",
  versions: [
    version({
      id: "pv",
      amount: "1000",
      recurrence: "WEEKLY",
      anchorDate: "2026-11-06",
      dayOfMonth: null,
      allocations: [
        { accountId: "spend", mode: "PERCENT", value: "70" },
        { accountId: "savings", mode: "REMAINDER", value: null },
      ],
    }),
  ],
});

/** The 1st of each month from Dec 1, 2026: $1,840.91 from Ally Spend. */
export const MORTGAGE = rule({ id: "mort", name: "Mortgage", versions: [version({ id: "mv", amount: "1840.91", anchorDate: "2026-12-01" })] });

/** The 15th of each month: $15.49 on the Amex card, so no cash moves. */
export const STREAMING = rule({
  id: "stream",
  name: "Streaming",
  versions: [
    version({
      id: "sv",
      amount: "15.49",
      anchorDate: "2026-11-15",
      dayOfMonth: 15,
      allocations: [{ accountId: "amex", mode: "REMAINDER", value: null }],
    }),
  ],
});

/** Ally Spend's balance ($2,000) is from today; Ally Savings' ($500) is from Nov 10. Amex has none. */
export const forecastInput = (patch: Partial<ForecastInput> = {}): ForecastInput => ({
  today: TODAY,
  days: FORECAST_DAYS,
  accounts: ACCOUNTS,
  snapshots: new Map([
    ["spend", snapshot("spend", TODAY, "2000")],
    ["savings", snapshot("savings", "2026-11-10", "500")],
  ]),
  rules: [PAYCHECK, MORTGAGE, STREAMING],
  overrides: [],
  ...patch,
});
