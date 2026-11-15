import { describe, expect, it } from "vitest";
import { attentionCount, needsAttention, upcoming } from "@/features/forecast/attention";
import { buildForecast, type ForecastInput } from "@/features/forecast/engine";
import { ACCOUNTS, MORTGAGE, PAYCHECK, STREAMING, TODAY, edit, forecastInput, rule, snapshot, version } from "./helpers/forecast-fixtures";

const attentionFor = (input: ForecastInput) => needsAttention(buildForecast(input), input);
const upcomingFor = (input: ForecastInput) => upcoming(buildForecast(input), input);

describe("needsAttention", () => {
  it("lists accounts with no balance", () => {
    const attention = attentionFor(forecastInput({ snapshots: new Map([["spend", snapshot("spend", TODAY, "2000")]]) }));
    expect(attention.needsBalance).toEqual([ACCOUNTS[1]]);
  });

  it("lists balances more than 7 days old", () => {
    const old = attentionFor(
      forecastInput({ snapshots: new Map([["spend", snapshot("spend", TODAY, "2000")], ["savings", snapshot("savings", "2026-11-06", "500")]]) }),
    );
    expect(old.stale).toEqual([{ account: ACCOUNTS[1], date: "2026-11-06", days: 8 }]);

    const recent = attentionFor(
      forecastInput({ snapshots: new Map([["spend", snapshot("spend", TODAY, "2000")], ["savings", snapshot("savings", "2026-11-07", "500")]]) }),
    );
    expect(recent.stale).toEqual([]);
  });

  it("lists accounts that go below their cushion or below zero, with the lowest point", () => {
    expect(attentionFor(forecastInput()).low).toEqual([]);

    const attention = attentionFor(
      forecastInput({
        overrides: [
          edit({ ruleId: "pay", scheduledOn: "2026-11-27", status: "SKIPPED" }),
          edit({ ruleId: "mort", scheduledOn: "2026-12-01", confirmedAmount: "3000" }),
        ],
      }),
    );
    expect(attention.low).toHaveLength(1);
    expect(attention.low[0]).toMatchObject({
      account: ACCOUNTS[0],
      lowest: { date: "2026-12-01", cents: -30000n },
      firstBelowCushion: "2026-12-01",
      firstBelowZero: "2026-12-01",
      daysBelowZero: 3,
    });
  });

  it("lists estimates in the next 14 days that move cash and are still open", () => {
    // The Nov 15 streaming bill is on a card, and the Dec 1 mortgage is past the 14 days.
    const plain = attentionFor(forecastInput());
    expect(plain.estimates.map((o) => [o.ruleName, o.date])).toEqual([
      ["Paycheck", "2026-11-20"],
      ["Paycheck", "2026-11-27"],
    ]);

    const settled = attentionFor(
      forecastInput({
        overrides: [
          edit({ ruleId: "pay", scheduledOn: "2026-11-20", confirmedAmount: "1000" }),
          edit({ ruleId: "pay", scheduledOn: "2026-11-27", status: "PAID" }),
        ],
      }),
    );
    expect(settled.estimates).toEqual([]);
  });

  it("asks 'Did it clear?' per account, for open occurrences on or up to 45 days before its balance date", () => {
    const once = (id: string, date: string) =>
      rule({
        id,
        name: `Bill ${date}`,
        versions: [version({ id: `${id}v`, effectiveFrom: "2026-09-01", amount: "10", recurrence: "ONCE", anchorDate: date, dayOfMonth: null })],
      });
    // Ally Spend's balance is from Nov 14, so Sep 30 is the earliest date asked about; Sep 29 is too old.
    const attention = attentionFor(forecastInput({ rules: [PAYCHECK, MORTGAGE, STREAMING, once("a", "2026-09-29"), once("b", "2026-09-30")] }));
    expect(attention.didItClear.map((q) => [q.occurrence.date, q.account.name, q.cents])).toEqual([
      ["2026-09-30", "Ally Spend", -1000n],
      ["2026-11-06", "Ally Savings", 30000n],
      ["2026-11-06", "Ally Spend", 70000n],
      ["2026-11-13", "Ally Spend", 70000n],
    ]);
    expect(attention.didItClear[1].snapshotDate).toBe("2026-11-10");

    const answered = attentionFor(
      forecastInput({
        overrides: [
          edit({ ruleId: "pay", scheduledOn: "2026-11-06", status: "SKIPPED" }),
          edit({ ruleId: "pay", scheduledOn: "2026-11-13", status: "PAID" }),
        ],
      }),
    );
    expect(answered.didItClear).toEqual([]);
  });

  it("lists per-date edits whose date the rule no longer produces", () => {
    const attention = attentionFor(forecastInput({ overrides: [edit({ ruleId: "mort", scheduledOn: "2026-11-15" })] }));
    expect(attention.orphanEdits).toEqual([{ ruleId: "mort", ruleName: "Mortgage", scheduledOn: "2026-11-15" }]);
  });

  it("counts every item", () => {
    // Two estimates (Nov 20 and Nov 27) and three "Did it clear?" questions.
    expect(attentionCount(attentionFor(forecastInput()))).toBe(5);
  });
});

describe("upcoming", () => {
  it("lists the next 7 days' occurrences that move cash, with each account's share", () => {
    const items = upcomingFor(forecastInput());
    expect(items.map((i) => [i.occurrence.ruleName, i.occurrence.date, i.shares.map((s) => [s.account.name, s.cents])])).toEqual([
      [
        "Paycheck",
        "2026-11-20",
        [
          ["Ally Spend", 70000n],
          ["Ally Savings", 30000n],
        ],
      ],
    ]);
  });

  it("includes cash accounts left out of the forecast, and leaves out Skipped occurrences", () => {
    const accounts = [ACCOUNTS[0], { ...ACCOUNTS[1], includeInForecast: false }, ACCOUNTS[2]];
    expect(upcomingFor(forecastInput({ accounts }))[0].shares.map((s) => s.account.name)).toEqual(["Ally Spend", "Ally Savings"]);

    expect(upcomingFor(forecastInput({ overrides: [edit({ ruleId: "pay", scheduledOn: "2026-11-20", status: "SKIPPED" })] }))).toEqual([]);
  });
});
