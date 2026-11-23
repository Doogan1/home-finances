import { describe, expect, it } from "vitest";
import { buildForecast, type AccountSeries, type ForecastInput } from "@/features/forecast/engine";
import { registerRows } from "@/features/forecast/register";
import { forecastInput, MORTGAGE, PAYCHECK, rule, STREAMING, version } from "./helpers/forecast-fixtures";

function series(input: ForecastInput, id: string): AccountSeries {
  const found = buildForecast(input).accounts.find((a): a is AccountSeries => a.kind === "forecast" && a.account.id === id);
  if (!found) throw new Error(`no series for ${id}`);
  return found;
}

describe("registerRows", () => {
  it("lists every item that moves the account, with the balance after it", () => {
    const rows = registerRows(series(forecastInput(), "spend"));
    expect(rows).toHaveLength(15);
    expect(rows.slice(0, 3).map((r) => [r.date, r.occurrence.ruleName, r.cents, r.balance])).toEqual([
      ["2026-11-20", "Paycheck", 70000n, 270000n],
      ["2026-11-27", "Paycheck", 70000n, 340000n],
      ["2026-12-01", "Mortgage", -184091n, 155909n],
    ]);
    expect(rows.at(-1)).toMatchObject({ date: "2027-02-05", balance: 487727n });
  });

  it("puts income before bills on the same day, and ends each day on its end-of-day balance", () => {
    const s = series(forecastInput(), "spend");
    const rows = registerRows(s);
    expect(rows.filter((r) => r.date === "2027-01-01").map((r) => [r.occurrence.ruleName, r.balance])).toEqual([
      ["Paycheck", 505909n],
      ["Mortgage", 321818n],
    ]);
    for (const day of s.days.filter((d) => d.items.length > 0)) {
      expect(rows.filter((r) => r.date === day.date).at(-1)?.balance).toBe(day.closing);
    }
  });

  it("marks each row with its day's flags", () => {
    const big = rule({
      id: "big",
      name: "Big bill",
      versions: [version({ id: "bv", amount: "2500", recurrence: "ONCE", anchorDate: "2026-11-16", dayOfMonth: null })],
    });
    const rows = registerRows(series(forecastInput({ rules: [PAYCHECK, MORTGAGE, STREAMING, big] }), "spend"));
    expect(rows[0]).toMatchObject({ date: "2026-11-16", balance: -50000n, belowZero: true, belowCushion: true });
    expect(rows[1]).toMatchObject({ date: "2026-11-20", balance: 20000n, belowZero: false, belowCushion: true });
  });
});
