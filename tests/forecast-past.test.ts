import { describe, expect, it } from "vitest";
import { pastDays, pastRows, type PastBalance, type PastTransaction } from "@/features/forecast/past";

// Every figure is made up.
const balance = (date: string, cents: bigint, hour = 12): PastBalance => ({ date, cents, observedAt: new Date(`${date}T${String(hour).padStart(2, "0")}:00:00Z`) });
const tx = (id: string, date: string, cents: bigint, payee = id): PastTransaction => ({ id, date, cents, payee, ruleId: null, ruleName: null });
const closings = (days: ReturnType<typeof pastDays>) => days.map((d) => [d.date, d.closing, d.from]);

describe("pastDays", () => {
  it("works each day back from the next one's balance and transactions", () => {
    const days = pastDays({
      from: "2026-11-10",
      to: "2026-11-13",
      balances: [balance("2026-11-14", 100000n)],
      transactions: [tx("rent", "2026-11-14", -40000n), tx("pay", "2026-11-12", 25000n), tx("food", "2026-11-12", -5000n)],
      bankSince: "2026-09-02",
    });
    // The 14th closed at $1,000 after $400 out, so the 13th closed at $1,400; the 12th's net +$200 puts the 11th at $1,200.
    expect(closings(days)).toEqual([
      ["2026-11-10", 120000n, "worked"],
      ["2026-11-11", 120000n, "worked"],
      ["2026-11-12", 140000n, "worked"],
      ["2026-11-13", 140000n, "worked"],
    ]);
    expect(days[2].transactions.map((t) => t.id)).toEqual(["pay", "food"]);
  });

  it("uses a saved balance on its own day, the one observed last, over anything worked out", () => {
    const days = pastDays({
      from: "2026-11-11",
      to: "2026-11-13",
      balances: [balance("2026-11-14", 100000n), balance("2026-11-12", 90000n, 9), balance("2026-11-12", 95000n, 18)],
      transactions: [tx("a", "2026-11-12", -1000n), tx("b", "2026-11-13", -2000n)],
      bankSince: "2026-11-11",
    });
    expect(closings(days)).toEqual([
      ["2026-11-11", 96000n, "worked"],
      ["2026-11-12", 95000n, "saved"],
      ["2026-11-13", 100000n, "worked"],
    ]);
  });

  it("carries the last saved balance forward for an account with no bank transactions", () => {
    const days = pastDays({
      from: "2026-11-01",
      to: "2026-11-13",
      balances: [balance("2026-11-14", 50000n), balance("2026-11-10", 70000n), balance("2026-11-12", 60000n)],
      transactions: [],
      bankSince: null,
    });
    expect(closings(days)).toEqual([
      ["2026-11-10", 70000n, "saved"],
      ["2026-11-11", 70000n, "carried"],
      ["2026-11-12", 60000n, "saved"],
      ["2026-11-13", 60000n, "carried"],
    ]);
  });

  it("starts where something is first known, and is empty with no balance or an empty window", () => {
    const one = { balances: [balance("2026-11-14", 100000n)], transactions: [tx("a", "2026-11-12", -1000n)], bankSince: "2026-11-12" };
    expect(pastDays({ from: "2026-10-01", to: "2026-11-13", ...one }).map((d) => d.date)).toEqual(["2026-11-12", "2026-11-13"]);
    expect(pastDays({ from: "2026-11-01", to: "2026-11-13", balances: [balance("2026-11-14", 1n)], transactions: [], bankSince: null })).toEqual([]);
    expect(pastDays({ from: "2026-11-01", to: "2026-11-13", balances: [], transactions: one.transactions, bankSince: one.bankSince })).toEqual([]);
    expect(pastDays({ from: "2026-11-14", to: "2026-11-13", ...one })).toEqual([]);
  });

  it("leans on a balance dated after the window when the latest balance is today's", () => {
    // The forecast starts today (the 14th), so the past ends on the 13th; the balance is from the 15th.
    const days = pastDays({
      from: "2026-11-12",
      to: "2026-11-13",
      balances: [balance("2026-11-15", 100000n)],
      transactions: [tx("a", "2026-11-15", -1000n), tx("b", "2026-11-14", -2000n)],
      bankSince: "2026-08-01",
    });
    expect(closings(days)).toEqual([
      ["2026-11-12", 103000n, "worked"],
      ["2026-11-13", 103000n, "worked"],
    ]);
  });
});

describe("pastRows", () => {
  it("lists a day's transactions with money in first, each with the balance after it, ending on the day's balance", () => {
    const days = pastDays({
      from: "2026-11-12",
      to: "2026-11-13",
      balances: [balance("2026-11-14", 100000n)],
      transactions: [tx("food", "2026-11-12", -5000n), tx("pay", "2026-11-12", 25000n), tx("gas", "2026-11-13", -3000n)],
      bankSince: "2026-11-12",
    });
    expect(pastRows(days).map((r) => [r.date, r.transaction.id, r.balance])).toEqual([
      ["2026-11-12", "pay", 108000n],
      ["2026-11-12", "food", 103000n],
      ["2026-11-13", "gas", 100000n],
    ]);
  });
});
