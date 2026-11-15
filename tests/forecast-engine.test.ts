import { describe, expect, it } from "vitest";
import { buildForecast, compareAccounts, type Forecast } from "@/features/forecast/engine";
import { ACCOUNTS, MORTGAGE, PAYCHECK, STREAMING, TODAY, account, edit, forecastInput, rule, snapshot, version } from "./helpers/forecast-fixtures";

function series(forecast: Forecast, id: string) {
  const found = forecast.accounts.find((a) => a.account.id === id);
  if (!found || found.kind !== "forecast") throw new Error(`${id} has no series`);
  return found;
}
const day = (forecast: Forecast, id: string, date: string) => {
  const found = series(forecast, id).days.find((d) => d.date === date);
  if (!found) throw new Error(`${id} has no ${date}`);
  return found;
};
const closing = (forecast: Forecast, id: string, date: string) => day(forecast, id, date).closing;

describe("buildForecast", () => {
  it("covers today and the next 89 days, starting each account the day after its balance (or today)", () => {
    const forecast = buildForecast(forecastInput());
    expect(forecast.today).toBe(TODAY);
    expect(forecast.end).toBe("2027-02-11");
    const spend = series(forecast, "spend");
    expect(spend.days).toHaveLength(90);
    expect(spend.days[0]).toMatchObject({ date: "2026-11-14", opening: 200000n, closing: 200000n, items: [] });
    expect(spend.days[89].date).toBe("2027-02-11");
    // Savings' balance is from Nov 10, so its series starts on Nov 11.
    const savings = series(forecast, "savings");
    expect(savings.days[0]).toMatchObject({ date: "2026-11-11", opening: 50000n });
    expect(savings.days).toHaveLength(93);
  });

  it("counts only occurrences after each account's own balance date", () => {
    const forecast = buildForecast(forecastInput());
    // The Nov 13 paycheck is before Ally Spend's balance (Nov 14), so it is already in it.
    expect(closing(forecast, "spend", "2026-11-19")).toBe(200000n);
    expect(closing(forecast, "spend", "2026-11-20")).toBe(270000n);
    expect(closing(forecast, "spend", "2026-11-27")).toBe(340000n);
    expect(closing(forecast, "spend", "2026-12-01")).toBe(155909n);
    expect(closing(forecast, "spend", "2026-12-04")).toBe(225909n);
    // It is after Ally Savings' balance (Nov 10), so it counts there.
    expect(closing(forecast, "savings", "2026-11-12")).toBe(50000n);
    expect(closing(forecast, "savings", "2026-11-13")).toBe(80000n);
    expect(closing(forecast, "savings", "2026-11-20")).toBe(110000n);
  });

  it("treats an occurrence on the balance date as already in the balance", () => {
    const coffee = rule({
      id: "coffee",
      name: "Coffee",
      versions: [version({ id: "cv", amount: "5", recurrence: "ONCE", anchorDate: TODAY, dayOfMonth: null })],
    });
    const forecast = buildForecast(forecastInput({ rules: [coffee] }));
    expect(day(forecast, "spend", TODAY).items).toEqual([]);
    expect(series(forecast, "spend").lowest.cents).toBe(200000n);
  });

  it("handles a balance dated after today: the series still runs from today, flat until the balance date", () => {
    // Balance is dated Nov 17 (today is Nov 14). The Nov 20 paycheck is the first occurrence after it.
    const forecast = buildForecast(
      forecastInput({ rules: [PAYCHECK], snapshots: new Map([["spend", snapshot("spend", "2026-11-17", "2000")], ["savings", snapshot("savings", TODAY, "500")]]) }),
    );
    const spend = series(forecast, "spend");
    expect(spend.days).toHaveLength(90);
    expect(spend.days[0]).toMatchObject({ date: TODAY, opening: 200000n, closing: 200000n, items: [] });
    for (const date of ["2026-11-15", "2026-11-17", "2026-11-19"]) expect(closing(forecast, "spend", date)).toBe(200000n);
    // The first occurrence after the balance date (Nov 20) is the first to count.
    expect(day(forecast, "spend", "2026-11-20").closing).toBe(270000n);
  });

  it("handles a balance dated after the end of the window: flat for the whole window", () => {
    const forecast = buildForecast(
      forecastInput({ snapshots: new Map([["spend", snapshot("spend", "2027-03-01", "2000")], ["savings", snapshot("savings", TODAY, "500")]]) }),
    );
    const spend = series(forecast, "spend");
    expect(spend.days).toHaveLength(90);
    expect(spend.days[0].date).toBe(TODAY);
    expect(spend.days[89].date).toBe("2027-02-11");
    expect(new Set(spend.days.map((d) => d.closing))).toEqual(new Set([200000n]));
    expect(spend.days.every((d) => d.items.length === 0)).toBe(true);
    expect(spend.lowest).toEqual({ date: TODAY, cents: 200000n });
  });

  it("nets out items on the same day", () => {
    const water = rule({
      id: "water",
      name: "Water",
      versions: [version({ id: "wv", amount: "200", recurrence: "ONCE", anchorDate: "2026-11-20", dayOfMonth: null })],
    });
    const forecast = buildForecast(forecastInput({ rules: [PAYCHECK, MORTGAGE, STREAMING, water] }));
    const nov20 = day(forecast, "spend", "2026-11-20");
    expect(nov20.opening).toBe(200000n);
    expect(nov20.items.map((i) => [i.occurrence.ruleName, i.cents])).toEqual([
      ["Paycheck", 70000n],
      ["Water", -20000n],
    ]);
    expect(nov20.closing).toBe(250000n);
  });

  it("never forecasts a card, and a bill paid from one moves no cash", () => {
    const forecast = buildForecast(forecastInput());
    expect(forecast.accounts.map((a) => a.account.id)).toEqual(["spend", "savings"]);
    expect(day(forecast, "spend", "2026-11-15").items).toEqual([]);
  });

  it("never forecasts a loan or an investment account, even with include-in-forecast on", () => {
    const loan = account("loan", { type: "loan", subtype: "mortgage" });
    const brokerage = account("brokerage", { type: "investment", subtype: "brokerage" });
    const forecast = buildForecast(
      forecastInput({
        accounts: [...ACCOUNTS, loan, brokerage],
        snapshots: new Map([
          ["spend", snapshot("spend", TODAY, "2000")],
          ["savings", snapshot("savings", "2026-11-10", "500")],
          ["loan", snapshot("loan", TODAY, "250000")],
          ["brokerage", snapshot("brokerage", TODAY, "12000")],
        ]),
      }),
    );
    expect(forecast.accounts.map((a) => a.account.id)).toEqual(["spend", "savings"]);
  });

  it("moves no cash for a bill paid from a card or a loan", () => {
    const toLoan = rule({
      id: "loanpay",
      name: "Loan payment",
      versions: [version({ id: "lv", anchorDate: "2026-11-15", dayOfMonth: 15, allocations: [{ accountId: "loan", mode: "REMAINDER", value: null }] })],
    });
    const accounts = [...ACCOUNTS, account("loan", { type: "loan", subtype: "mortgage" })];
    const plain = buildForecast(forecastInput({ accounts, rules: [] }));
    const withBills = buildForecast(forecastInput({ accounts, rules: [STREAMING, toLoan] }));
    for (const id of ["spend", "savings"]) {
      expect(series(withBills, id).days.map((d) => [d.date, d.closing, d.items])).toEqual(series(plain, id).days.map((d) => [d.date, d.closing, d.items]));
    }
  });

  it("still counts a Paid occurrence after the balance, and never a Skipped one", () => {
    const forecast = buildForecast(
      forecastInput({
        overrides: [
          edit({ ruleId: "mort", scheduledOn: "2026-12-01", status: "PAID" }),
          edit({ ruleId: "pay", scheduledOn: "2026-11-27", status: "SKIPPED" }),
        ],
      }),
    );
    expect(closing(forecast, "spend", "2026-11-27")).toBe(270000n);
    expect(closing(forecast, "spend", "2026-12-01")).toBe(85909n);
  });

  it("counts a moved occurrence on its new date, on whichever side of the balance that is", () => {
    const later = buildForecast(forecastInput({ overrides: [edit({ ruleId: "pay", scheduledOn: "2026-11-13", movedTo: "2026-11-17" })] }));
    expect(closing(later, "spend", "2026-11-17")).toBe(270000n);
    expect(closing(later, "savings", "2026-11-13")).toBe(50000n);
    expect(closing(later, "savings", "2026-11-17")).toBe(80000n);

    const earlier = buildForecast(forecastInput({ overrides: [edit({ ruleId: "mort", scheduledOn: "2026-12-01", movedTo: "2026-11-12" })] }));
    expect(closing(earlier, "spend", "2026-12-01")).toBe(340000n);
  });

  it("uses a confirmed amount instead of the estimate", () => {
    const forecast = buildForecast(forecastInput({ overrides: [edit({ ruleId: "mort", scheduledOn: "2026-12-01", confirmedAmount: "1900" })] }));
    const dec1 = day(forecast, "spend", "2026-12-01");
    expect(dec1.items.map((i) => [i.cents, i.occurrence.estimate])).toEqual([[-190000n, false]]);
    expect(dec1.closing).toBe(150000n);
  });

  it("flags days below the cushion and below zero, and finds the lowest point", () => {
    const plain = buildForecast(forecastInput());
    expect(series(plain, "spend").lowest).toEqual({ date: "2026-12-01", cents: 155909n });

    const forecast = buildForecast(
      forecastInput({
        overrides: [
          edit({ ruleId: "pay", scheduledOn: "2026-11-27", status: "SKIPPED" }),
          edit({ ruleId: "mort", scheduledOn: "2026-12-01", confirmedAmount: "3000" }),
        ],
      }),
    );
    expect(day(forecast, "spend", "2026-11-30")).toMatchObject({ closing: 270000n, belowZero: false, belowCushion: false });
    expect(day(forecast, "spend", "2026-12-01")).toMatchObject({ closing: -30000n, belowZero: true, belowCushion: true });
    expect(day(forecast, "spend", "2026-12-04")).toMatchObject({ closing: 40000n, belowZero: false, belowCushion: true });
    expect(series(forecast, "spend").lowest).toEqual({ date: "2026-12-01", cents: -30000n });
    // No cushion, no cushion warnings.
    expect(series(forecast, "savings").days.some((d) => d.belowCushion)).toBe(false);
  });

  it("lists an account with no balance as needing one", () => {
    const forecast = buildForecast(forecastInput({ snapshots: new Map([["spend", snapshot("spend", TODAY, "2000")]]) }));
    expect(forecast.accounts[1]).toEqual({ kind: "needs_balance", account: ACCOUNTS[1] });
  });

  it("leaves out archived accounts, accounts left out of the forecast, and accounts the bank stopped reporting", () => {
    const forecast = buildForecast(
      forecastInput({
        accounts: [
          ...ACCOUNTS,
          account("old", { archived: true }),
          account("off", { includeInForecast: false }),
          account("gone", { active: false }),
        ],
      }),
    );
    expect(forecast.accounts.map((a) => a.account.id)).toEqual(["spend", "savings"]);
  });
});

describe("compareAccounts", () => {
  it("puts accounts with a cushion first, then checking, then by name", () => {
    const sorted = [
      account("b", { name: "B", subtype: "savings" }),
      account("a", { name: "A" }),
      account("z", { name: "Z", subtype: "savings", cushion: "10" }),
    ].sort(compareAccounts);
    expect(sorted.map((a) => a.id)).toEqual(["z", "a", "b"]);
  });
});
