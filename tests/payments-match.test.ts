import { describe, expect, it } from "vitest";
import { proposeMatches, type KnownPayment, type MatchInput, type MatchRule, type MatchTransaction } from "@/features/payments/match";
import { payeeKey, sharesWord } from "@/features/payments/payee";
import { edit, rule, version } from "./helpers/forecast-fixtures";

// Monthly on the 1st from Nov 1, 2026, $100 from "spend". Every figure is made up.
const power = (patch: Partial<MatchRule> = {}): MatchRule => ({ ...rule({ id: "power", name: "Power company" }), estimateMode: "FIXED", ...patch });
const tx = (patch: Partial<MatchTransaction> = {}): MatchTransaction => ({
  id: "t1",
  accountId: "spend",
  date: "2026-12-02",
  amount: "100",
  payeeKey: "city power light",
  ...patch,
});
const paidBefore: KnownPayment = { ruleId: "power", scheduledOn: "2026-11-01", accountId: "spend", payeeKey: "city power light" };
const propose = (patch: Partial<MatchInput>) => proposeMatches({ rules: [power()], overrides: [], payments: [], declines: [], transactions: [tx()], ...patch });

describe("payeeKey", () => {
  it("prefers the merchant name, and drops case, punctuation and anything with a digit", () => {
    expect(payeeKey("City Power & Light", "ACH DEBIT 99812 CITY PWR")).toBe("city power light");
    expect(payeeKey(null, "POPPINS PAYROLL 1234567 PPD ID: 9A8B")).toBe("poppins payroll ppd id");
    expect(payeeKey("  ", "Check #1042")).toBe("check");
  });

  it("keeps something for a description that is only numbers", () => {
    expect(payeeKey(null, "  1042   77 ")).toBe("1042 77");
  });

  it("finds a shared word of three letters or more, ignoring filler", () => {
    expect(sharesWord("Power company", "city power light")).toBe(true);
    expect(sharesWord("Car payment", "payment thank you")).toBe(false);
    expect(sharesWord("AT&T", "at t wireless")).toBe(false);
  });
});

describe("proposeMatches", () => {
  it("asks about a transaction that shares a word with the bill, on its nearest due date", () => {
    expect(propose({})).toEqual([{ transactionId: "t1", ruleId: "power", scheduledOn: "2026-12-01", auto: false }]);
  });

  it("links without asking once the payee is known for that bill and the amount is plausible", () => {
    expect(propose({ payments: [paidBefore], transactions: [tx({ amount: "118.40" })] })).toEqual([
      { transactionId: "t1", ruleId: "power", scheduledOn: "2026-12-01", auto: true },
    ]);
  });

  it("still asks when a known payee's amount is far off, unless the bill varies", () => {
    const far = { payments: [paidBefore], transactions: [tx({ amount: "180" })] };
    expect(propose(far)[0].auto).toBe(false);
    expect(propose({ ...far, rules: [power({ estimateMode: "VARIES" })] })[0].auto).toBe(true);
  });

  it("ignores the wrong direction, the wrong account and anything more than 10 days from a due date", () => {
    expect(propose({ transactions: [tx({ amount: "-100" })] })).toEqual([]);
    expect(propose({ transactions: [tx({ accountId: "savings" })] })).toEqual([]);
    expect(propose({ transactions: [tx({ date: "2026-12-12" })] })).toEqual([]);
    expect(propose({ transactions: [tx({ date: "2026-12-11" })] })).toHaveLength(1);
  });

  it("asks about an unknown payee only when the amount and date both fit closely", () => {
    const unknown = (patch: Partial<MatchTransaction>) => propose({ transactions: [tx({ payeeKey: "web pmt", ...patch })] });
    expect(unknown({ amount: "100.50", date: "2026-12-04" })).toHaveLength(1);
    expect(unknown({ amount: "104", date: "2026-12-04" })).toEqual([]);
    expect(unknown({ amount: "100", date: "2026-12-05" })).toEqual([]);
  });

  it("never proposes a declined pair, and stops linking a declined payee without asking", () => {
    const declined = { ruleId: "power", transactionId: "t0", payeeKey: "city power light" };
    expect(propose({ payments: [paidBefore], declines: [declined] })[0].auto).toBe(false);
    expect(propose({ payments: [paidBefore], declines: [{ ...declined, transactionId: "t1" }] })).toEqual([]);
  });

  it("skips due dates that are paid for that account or skipped, and takes the next nearest", () => {
    const paid: KnownPayment = { ...paidBefore, scheduledOn: "2026-12-01" };
    expect(propose({ payments: [paid], transactions: [tx({ date: "2026-12-24" })] })).toEqual([
      { transactionId: "t1", ruleId: "power", scheduledOn: "2027-01-01", auto: true },
    ]);
    expect(propose({ overrides: [edit({ ruleId: "power", scheduledOn: "2026-12-01", status: "SKIPPED" })] })).toEqual([]);
  });

  it("gives two payments to the same payee two different due dates", () => {
    const weekly = power({ versions: [version({ recurrence: "WEEKLY", anchorDate: "2026-11-02", dayOfMonth: null })] });
    const result = propose({
      rules: [weekly],
      payments: [{ ...paidBefore, scheduledOn: "2026-11-02" }],
      transactions: [tx({ id: "a", date: "2026-11-09" }), tx({ id: "b", date: "2026-11-10" })],
    });
    expect(result).toEqual([
      { transactionId: "a", ruleId: "power", scheduledOn: "2026-11-09", auto: true },
      { transactionId: "b", ruleId: "power", scheduledOn: "2026-11-16", auto: true },
    ]);
  });

  it("asks rather than links when two due dates are equally near", () => {
    const weekly = power({ versions: [version({ recurrence: "WEEKLY", interval: 2, anchorDate: "2026-11-02", dayOfMonth: null })] });
    const result = propose({ rules: [weekly], payments: [{ ...paidBefore, scheduledOn: null }], transactions: [tx({ date: "2026-11-09" })] });
    expect(result).toEqual([{ transactionId: "t1", ruleId: "power", scheduledOn: "2026-11-02", auto: false }]);
  });

  it("asks when two bills know the same payee, preferring the closer amount", () => {
    const water = power({ id: "water", name: "Water", versions: [version({ id: "v2", amount: "40" })] });
    const result = propose({
      rules: [power(), water],
      payments: [
        { ...paidBefore, payeeKey: "utilities web pay" },
        { ...paidBefore, ruleId: "water", payeeKey: "utilities web pay" },
      ],
      transactions: [tx({ amount: "41", payeeKey: "utilities web pay" })],
    });
    expect(result).toEqual([{ transactionId: "t1", ruleId: "water", scheduledOn: "2026-12-01", auto: false }]);
  });

  it("keeps a payment from before the bill's first date as history, with no due date", () => {
    expect(propose({ payments: [paidBefore], transactions: [tx({ date: "2026-09-03", amount: "96" })] })).toEqual([
      { transactionId: "t1", ruleId: "power", scheduledOn: null, auto: true },
    ]);
    // Just before the first date, it pays that first date instead.
    expect(propose({ transactions: [tx({ date: "2026-10-29" })] })[0].scheduledOn).toBe("2026-11-01");
  });

  it("matches a deposit to each account a split paycheck lands in, by that account's share", () => {
    const pay: MatchRule = {
      ...rule({
        id: "pay",
        name: "Acme payroll",
        kind: "INCOME",
        versions: [
          version({
            amount: "1000",
            allocations: [
              { accountId: "spend", mode: "PERCENT", value: "70" },
              { accountId: "savings", mode: "REMAINDER", value: null },
            ],
          }),
        ],
      }),
      estimateMode: "FIXED",
    };
    const deposit = (id: string, accountId: string, amount: string) => tx({ id, accountId, amount, date: "2026-12-01", payeeKey: "acme corp payroll" });
    expect(propose({ rules: [pay], transactions: [deposit("a", "spend", "-700"), deposit("b", "savings", "-300")] })).toEqual([
      { transactionId: "a", ruleId: "pay", scheduledOn: "2026-12-01", auto: false },
      { transactionId: "b", ruleId: "pay", scheduledOn: "2026-12-01", auto: false },
    ]);
  });
});
