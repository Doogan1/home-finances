import { describe, expect, it } from "vitest";
import { calendarMonth, chooseMonth, formatMonth, pastItems, seriesMonths } from "@/features/forecast/calendar";
import { occurrencesBetween } from "@/features/forecast/occurrences";
import { buildForecast, type AccountSeries } from "@/features/forecast/engine";
import { edit, forecastInput, rule, TODAY } from "./helpers/forecast-fixtures";

const spend = (): AccountSeries => {
  const found = buildForecast(forecastInput()).accounts.find((a): a is AccountSeries => a.kind === "forecast" && a.account.id === "spend");
  if (!found) throw new Error("no series");
  return found;
};

describe("the forecast's months", () => {
  it("are the months the series covers", () => {
    expect(seriesMonths(spend())).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });

  it("choose the requested month only when it is one of them, otherwise today's", () => {
    expect(chooseMonth(spend(), undefined, TODAY)).toBe("2026-11");
    expect(chooseMonth(spend(), "2027-02", TODAY)).toBe("2027-02");
    expect(chooseMonth(spend(), "2030-01", TODAY)).toBe("2026-11");
    expect(chooseMonth(spend(), "nonsense", TODAY)).toBe("2026-11");
  });

  it("are named in full", () => {
    expect(formatMonth("2026-12")).toBe("December 2026");
  });
});

describe("calendarMonth", () => {
  it("is a Sunday-first grid of whole weeks, with the items and end-of-day balance on each day", () => {
    const month = calendarMonth(spend(), "2026-12", TODAY);
    expect(month.weeks).toHaveLength(5);
    expect(month.weeks.every((week) => week.length === 7)).toBe(true);
    expect(month.weeks[0][0]).toMatchObject({ date: "2026-11-29", inMonth: false, closing: 340000n, items: [] });
    const dec1 = month.weeks[0][2];
    expect(dec1).toMatchObject({ date: "2026-12-01", inMonth: true, closing: 155909n });
    expect(dec1.items.map((i) => [i.occurrence.ruleName, i.cents])).toEqual([["Mortgage", -184091n]]);
    expect(month.weeks[4][6]).toMatchObject({ date: "2027-01-02", inMonth: false, closing: 321818n });
    expect([month.previous, month.next]).toEqual(["2026-11", "2027-01"]);
  });

  it("shows no balance before the series starts or after it ends, and marks today", () => {
    const november = calendarMonth(spend(), "2026-11", TODAY);
    expect(november.weeks[0][0]).toMatchObject({ date: "2026-11-01", closing: null });
    expect(november.weeks[1][5]).toMatchObject({ date: "2026-11-13", closing: null, today: false });
    expect(november.weeks[1][6]).toMatchObject({ date: "2026-11-14", closing: 200000n, today: true });
    expect(november.previous).toBeNull();

    const february = calendarMonth(spend(), "2027-02", TODAY);
    const days = february.weeks.flat();
    expect(days.find((d) => d.date === "2027-02-11")?.closing).toBe(487727n);
    expect(days.find((d) => d.date === "2027-02-12")?.closing).toBeNull();
    expect(february.next).toBeNull();
  });
});

describe("the calendar's past", () => {
  // The series starts on Nov 14. Before it: two saved days, and a bill due on the 1st.
  const past = (state: { matched?: string[]; bankSince?: string | null; overrides?: Parameters<typeof occurrencesBetween>[1] } = {}) => ({
    days: [
      { date: "2026-10-30", closing: 90000n, from: "saved" as const, transactions: [] },
      { date: "2026-11-01", closing: -500n, from: "worked" as const, transactions: [] },
    ],
    items: pastItems(occurrencesBetween([rule()], state.overrides ?? [], "2026-10-01", "2026-11-13"), "spend", "2026-11-14", {
      matched: new Set(state.matched ?? []),
      bankSince: state.bankSince === undefined ? "2026-10-01" : state.bankSince,
    }),
  });

  it("reaches back to the month of the first past day", () => {
    expect(seriesMonths(spend(), "2026-10-30")).toEqual(["2026-10", "2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(chooseMonth(spend(), "2026-10", TODAY, "2026-10-30")).toBe("2026-10");
    expect(chooseMonth(spend(), "2026-10", TODAY)).toBe("2026-11");
    expect(calendarMonth(spend(), "2026-11", TODAY, past()).previous).toBe("2026-10");
  });

  it("shows past days' balances and what was due, tinted like any other day", () => {
    const november = calendarMonth(spend(), "2026-11", TODAY, past()).weeks.flat();
    const first = november.find((d) => d.date === "2026-11-01");
    expect(first).toMatchObject({ closing: -500n, belowZero: true });
    expect(first?.items.map((i) => [i.occurrence.ruleName, i.cents, i.past])).toEqual([["Mortgage", -10000n, "unpaid"]]);
    expect(november.find((d) => d.date === "2026-11-02")).toMatchObject({ closing: null, items: [] });
    // Days in the forecast are untouched by the past.
    expect(november.find((d) => d.date === "2026-11-14")).toMatchObject({ closing: 200000n });
  });

  it("says how each past item stands", () => {
    const state = (options: Parameters<typeof past>[0]) => [...past(options).items.values()].flat().map((i) => i.past);
    expect(state({ matched: ["r1|2026-11-01"] })).toEqual(["bank"]);
    expect(state({ overrides: [edit({ scheduledOn: "2026-11-01", status: "PAID" })] })).toEqual(["hand"]);
    expect(state({ bankSince: null })).toEqual(["planned"]);
    expect(state({ bankSince: "2026-11-02" })).toEqual(["planned"]);
    expect(state({ overrides: [edit({ scheduledOn: "2026-11-01", status: "SKIPPED" })] })).toEqual([]);
    // A paid date sits on the day the bank shows, and another account's share is not this account's.
    const moved = past({ matched: ["r1|2026-11-01"], overrides: [edit({ scheduledOn: "2026-11-01", status: "PAID", movedTo: "2026-10-30" })] });
    expect([...moved.items.keys()]).toEqual(["2026-10-30"]);
    expect(pastItems(occurrencesBetween([rule()], [], "2026-10-01", "2026-11-13"), "savings", "2026-11-14", { matched: new Set(), bankSince: "2026-10-01" }).size).toBe(0);
  });
});
