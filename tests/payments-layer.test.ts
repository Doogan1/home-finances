import { describe, expect, it } from "vitest";
import { occurrencesBetween } from "@/features/forecast/occurrences";
import { paymentHistory, type HistoryPayment } from "@/features/payments/history";
import { layerPayments, paymentTotals, typicalAmount, usableTypical, type LayerPayment } from "@/features/payments/layer";
import { edit, rule, version } from "./helpers/forecast-fixtures";

// Monthly on the 1st from Nov 1, 2026, $100 from "spend". Every figure is made up.
const paid = (patch: Partial<LayerPayment> = {}): LayerPayment => ({
  ruleId: "r1",
  scheduledOn: "2026-12-01",
  accountId: "spend",
  date: "2026-11-28",
  cents: 11250n,
  ...patch,
});
const paycheck = rule({
  id: "pay",
  name: "Paycheck",
  kind: "INCOME",
  versions: [
    version({
      amount: "1000",
      allocations: [
        { accountId: "spend", mode: "FIXED", value: "700" },
        { accountId: "savings", mode: "REMAINDER", value: null },
      ],
    }),
  ],
});

describe("layerPayments", () => {
  it("marks a paid occurrence Paid, with the real amount on the real date", () => {
    expect(layerPayments([rule()], [], [paid()])).toEqual([
      { ruleId: "r1", scheduledOn: "2026-12-01", status: "PAID", confirmedAmount: "112.50", movedTo: "2026-11-28" },
    ]);
  });

  it("adds part payments up and uses the latest one's date; a payment on the due date moves nothing", () => {
    const parts = [paid({ cents: 4000n, date: "2026-12-01" }), paid({ cents: 6000n, date: "2026-11-30" })];
    expect(layerPayments([rule()], [], parts)[0]).toMatchObject({ confirmedAmount: "100.00", movedTo: null });
  });

  it("lays over the person's edit without losing the others, so undoing a match restores it", () => {
    const mine = edit({ scheduledOn: "2026-12-01", status: "CONFIRMED", confirmedAmount: "99", movedTo: "2026-12-03" });
    const other = edit({ scheduledOn: "2027-01-01", status: "SKIPPED" });
    const layered = layerPayments([rule()], [mine, other], [paid()]);
    expect(layered).toEqual([{ ...mine, status: "PAID", confirmedAmount: "112.50", movedTo: "2026-11-28" }, other]);
    expect(layerPayments([rule()], [mine, other], [])).toEqual([mine, other]);
  });

  it("keeps the amount as it was until every account of a split has its payment", () => {
    const toSpend = paid({ ruleId: "pay", accountId: "spend", cents: 70000n, date: "2026-12-01" });
    expect(layerPayments([paycheck], [], [toSpend])[0]).toMatchObject({ status: "PAID", confirmedAmount: null });
    const toSavings = paid({ ruleId: "pay", accountId: "savings", cents: 32000n, date: "2026-12-02" });
    expect(layerPayments([paycheck], [], [toSpend, toSavings])[0]).toMatchObject({ confirmedAmount: "1020.00", movedTo: "2026-12-02" });
  });

  it("keeps the amount as it was when the splits cannot divide what was paid", () => {
    const short = [paid({ ruleId: "pay", accountId: "spend", cents: 50000n }), paid({ ruleId: "pay", accountId: "savings", cents: 10000n })];
    expect(layerPayments([paycheck], [], short)[0]).toMatchObject({ status: "PAID", confirmedAmount: null });
  });

  it("changes nothing for a payment with no due date, a date the rule does not produce, or an unknown rule", () => {
    const stray = [paid({ scheduledOn: null }), paid({ scheduledOn: "2026-12-15" }), paid({ ruleId: "gone" })];
    expect(layerPayments([rule()], [], stray)).toEqual([]);
  });

  it("feeds the forecast: the occurrence lands on the payment's date with the real amount, confirmed", () => {
    const [occurrence] = occurrencesBetween([rule()], layerPayments([rule()], [], [paid()]), "2026-11-15", "2026-12-31");
    expect(occurrence).toMatchObject({ scheduledOn: "2026-12-01", date: "2026-11-28", status: "PAID", estimate: false, amount: 11250n });
  });
});

describe("typical amounts", () => {
  const months = ["2026-06-02", "2026-07-01", "2026-08-03", "2026-09-01", "2026-10-01", "2026-11-02", "2026-12-01"];
  const history = (amounts: bigint[]) =>
    amounts.map((cents, i) => paid({ scheduledOn: i < 5 ? null : `2026-${i === 5 ? "11" : "12"}-01`, date: months[i], cents }));

  it("totals each due date, and each day of payments that have no due date", () => {
    const totals = paymentTotals(rule(), [...history([9000n, 9500n]), paid({ cents: 4000n }), paid({ cents: 6100n, date: "2026-11-30" })]);
    expect(totals).toEqual([
      { date: "2026-06-02", cents: 9000n },
      { date: "2026-07-01", cents: 9500n },
      { date: "2026-11-30", cents: 10100n },
    ]);
  });

  it("leaves out a split payment that has not reached every account", () => {
    const toSpend = paid({ ruleId: "pay", accountId: "spend", cents: 70000n });
    expect(paymentTotals(paycheck, [toSpend])).toEqual([]);
    expect(paymentTotals(paycheck, [toSpend, paid({ ruleId: "pay", accountId: "savings", cents: 30000n })])).toHaveLength(1);
  });

  it("needs three payments, and takes the median of the last six", () => {
    expect(typicalAmount(paymentTotals(rule(), history([9000n, 9500n])))).toBeNull();
    expect(typicalAmount(paymentTotals(rule(), history([9000n, 9500n, 30000n])))).toEqual({ cents: 9500n, count: 3, low: 9000n, high: 30000n });
    // Seven payments: the oldest ($1) is left out, and the middle two of six are averaged, half up.
    const seven = history([100n, 9000n, 9501n, 30000n, 10000n, 9900n, 10200n]);
    expect(typicalAmount(paymentTotals(rule(), seven))).toEqual({ cents: 9950n, count: 6, low: 9000n, high: 30000n });
  });

  it("is not used when a version's splits cannot divide it", () => {
    const deposits = (cents: bigint, date: string) => [
      paid({ ruleId: "pay", scheduledOn: null, accountId: "spend", cents, date }),
      paid({ ruleId: "pay", scheduledOn: null, accountId: "savings", cents: 100n, date }),
    ];
    const low = [...deposits(50000n, "2026-08-01"), ...deposits(50000n, "2026-09-01"), ...deposits(50000n, "2026-10-01")];
    expect(usableTypical(paycheck, low)).toBeNull();
    expect(usableTypical(rule(), history([9000n, 9500n, 30000n]))?.cents).toBe(9500n);
  });
});

describe("a rule whose amount varies", () => {
  it("uses the typical amount from its start date on, still as an estimate, and never over a confirmed amount", () => {
    const varies = rule({ typical: { amount: "117.25", from: "2026-12-01" } });
    const result = occurrencesBetween([varies], [edit({ scheduledOn: "2027-01-01", confirmedAmount: "90" })], "2026-11-01", "2027-01-31");
    expect(result.map((o) => [o.date, o.amount, o.estimate])).toEqual([
      ["2026-11-01", 10000n, true],
      ["2026-12-01", 11725n, true],
      ["2027-01-01", 9000n, false],
    ]);
  });
});

describe("paymentHistory", () => {
  const bank = (patch: Partial<HistoryPayment>): HistoryPayment => ({
    transactionId: "t1",
    scheduledOn: "2026-12-01",
    date: "2026-11-28",
    cents: 11250n,
    payee: "City Power",
    source: "AUTO",
    ...patch,
  });

  it("lists each due date up to today with what was planned and what was paid, newest first", () => {
    const rows = paymentHistory(
      rule(),
      [edit({ scheduledOn: "2026-11-01", status: "PAID", confirmedAmount: "98" })],
      [bank({}), bank({ transactionId: "t0", scheduledOn: null, date: "2026-09-30", cents: 9000n })],
      "2026-06-01",
      "2026-12-14",
    );
    expect(rows).toEqual([
      { scheduledOn: "2026-12-01", date: "2026-11-28", planned: 10000n, status: "PLANNED", payments: [bank({})], paid: 11250n },
      { scheduledOn: "2026-11-01", date: "2026-11-01", planned: 9800n, status: "PAID", payments: [], paid: null },
      { scheduledOn: null, date: "2026-09-30", planned: null, status: null, payments: [expect.objectContaining({ transactionId: "t0" })], paid: 9000n },
    ]);
  });

  it("includes a later due date only when it is already paid, and never uses the typical amount as the plan", () => {
    const varies = rule({ typical: { amount: "500", from: "2026-11-01" } });
    const early = bank({ scheduledOn: "2027-01-01", date: "2026-12-12" });
    expect(paymentHistory(varies, [], [], "2026-11-15", "2026-12-14").map((r) => [r.scheduledOn, r.planned])).toEqual([["2026-12-01", 10000n]]);
    expect(paymentHistory(varies, [], [early], "2026-11-15", "2026-12-14").map((r) => r.scheduledOn)).toEqual(["2027-01-01", "2026-12-01"]);
  });
});
