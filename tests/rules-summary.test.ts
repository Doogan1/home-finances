import { describe, expect, it } from "vitest";
import type { DatedPattern, Pattern } from "@/features/rules/recurrence";
import {
  describeAllocations,
  describeSchedule,
  formatIsoDate,
  latestVersion,
  monthlyEquivalent,
  ordinal,
  ruleGroup,
  ruleState,
  versionFor,
} from "@/features/rules/summary";

const pattern = (p: Partial<Pattern>): Pattern => ({
  recurrence: "MONTHLY",
  interval: 1,
  anchorDate: "2026-12-01",
  dayOfMonth: 1,
  secondDay: null,
  ...p,
});
const dated = (effectiveFrom: string, effectiveTo: string | null): DatedPattern => ({
  ...pattern({ anchorDate: effectiveFrom }),
  effectiveFrom,
  effectiveTo,
});

describe("describing a schedule", () => {
  it("writes ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st",
    ]);
  });

  it("formats calendar dates without shifting them", () => {
    expect(formatIsoDate("2030-01-04")).toBe("Jan 4, 2030");
  });

  it("says each kind of schedule the way the household reads it", () => {
    expect(describeSchedule(pattern({}))).toBe("Monthly, 1st");
    expect(describeSchedule(pattern({ dayOfMonth: 31, anchorDate: "2026-11-30" }))).toBe("Monthly, last day");
    expect(describeSchedule(pattern({ interval: 6, dayOfMonth: 26, anchorDate: "2026-11-26" }))).toBe("Every 6 months, 26th");
    expect(describeSchedule(pattern({ recurrence: "WEEKLY", anchorDate: "2026-11-20", dayOfMonth: null }))).toBe("Every Friday");
    expect(describeSchedule(pattern({ recurrence: "WEEKLY", interval: 2, anchorDate: "2026-11-20", dayOfMonth: null }))).toBe(
      "Every 2 weeks, Friday",
    );
    expect(describeSchedule(pattern({ recurrence: "TWICE_MONTHLY", dayOfMonth: 5, secondDay: 20 }))).toBe("5th and 20th");
    expect(describeSchedule(pattern({ recurrence: "TWICE_MONTHLY", dayOfMonth: 15, secondDay: 31 }))).toBe("15th and last day");
    expect(describeSchedule(pattern({ recurrence: "ONCE", anchorDate: "2026-12-15", dayOfMonth: null }))).toBe(
      "Once, Dec 15, 2026",
    );
  });
});

describe("monthly equivalent", () => {
  it("weights weekly by 52 weeks over 12 months, rounded half up", () => {
    expect(monthlyEquivalent(192694n, { recurrence: "WEEKLY", interval: 1 })).toBe(835007n); // $8,350.07
    expect(monthlyEquivalent(30000n, { recurrence: "WEEKLY", interval: 1 })).toBe(130000n); // $1,300.00
    expect(monthlyEquivalent(100000n, { recurrence: "WEEKLY", interval: 2 })).toBe(216667n);
  });

  it("divides every-N-months and doubles twice a month", () => {
    expect(monthlyEquivalent(108900n, { recurrence: "MONTHLY", interval: 6 })).toBe(18150n); // $181.50
    expect(monthlyEquivalent(184091n, { recurrence: "MONTHLY", interval: 1 })).toBe(184091n);
    expect(monthlyEquivalent(169000n, { recurrence: "TWICE_MONTHLY", interval: 1 })).toBe(338000n);
  });

  it("has none for a one-off", () => {
    expect(monthlyEquivalent(5000n, { recurrence: "ONCE", interval: 1 })).toBeNull();
  });
});

describe("describing splits", () => {
  it("names a single account on its own", () => {
    expect(describeAllocations([{ accountId: "a", mode: "REMAINDER", value: null, accountName: "Ally Spend" }])).toBe("Ally Spend");
  });

  it("lists shares with the rest last, without trailing zeros", () => {
    expect(
      describeAllocations([
        { accountId: "s", mode: "REMAINDER", value: null, accountName: "Ally Savings" },
        { accountId: "a", mode: "PERCENT", value: "70.0000", accountName: "Ally Spend" },
        { accountId: "p", mode: "PERCENT", value: "15", accountName: "PNC" },
      ]),
    ).toBe("70% Ally Spend · 15% PNC · rest Ally Savings");
    expect(
      describeAllocations([
        { accountId: "a", mode: "FIXED", value: "200", accountName: "Ally Spend" },
        { accountId: "s", mode: "REMAINDER", value: null, accountName: "Savings" },
      ]),
    ).toBe("$200.00 Ally Spend · rest Savings");
  });
});

describe("rule state and the version to show", () => {
  const v1 = dated("2026-11-20", "2026-12-31");
  const v2 = dated("2027-01-01", null);

  it("finds the latest version", () => {
    expect(latestVersion([v2, v1])).toBe(v2);
  });

  it("shows the version in effect, else the next to start, else the latest", () => {
    expect(versionFor([v1, v2], "2026-12-31")).toBe(v1);
    expect(versionFor([v1, v2], "2027-01-01")).toBe(v2);
    expect(versionFor([v1, v2], "2026-01-01")).toBe(v1);
    expect(versionFor([v1], "2027-06-01")).toBe(v1);
  });

  it("is ended only once the latest version's end has passed", () => {
    expect(ruleState({ archivedAt: null, versions: [v1] }, "2026-12-31")).toBe("active");
    expect(ruleState({ archivedAt: null, versions: [v1] }, "2027-01-01")).toBe("ended");
    expect(ruleState({ archivedAt: null, versions: [v1, v2] }, "2030-01-01")).toBe("active");
    expect(ruleState({ archivedAt: new Date(), versions: [v2] }, "2027-01-01")).toBe("archived");
  });

  it("groups income, bills paid from cash accounts, and bills on cards", () => {
    expect(ruleGroup("INCOME", ["depository", "depository"])).toBe("income");
    expect(ruleGroup("BILL", ["depository"])).toBe("checking");
    expect(ruleGroup("BILL", ["credit"])).toBe("cards");
  });
});
