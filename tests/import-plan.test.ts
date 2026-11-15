import { describe, expect, it } from "vitest";
import { parseChoices } from "@/features/import/choices";
import { parsedWorkbook, planned } from "./helpers/import-fixtures";
import { STANDARD_CHOICES, day } from "./helpers/workbook-fixture";

const rule = (plan: ReturnType<typeof planned>, ref: string) => {
  const found = plan.rules.find((r) => r.ref === ref);
  if (!found) throw new Error(`no rule ${ref}`);
  return found;
};

describe("parseChoices", () => {
  it("reads the three sections, each optional", () => {
    expect(parseChoices(JSON.stringify(STANDARD_CHOICES))).toEqual({ ok: true, choices: STANDARD_CHOICES });
    expect(parseChoices("{}")).toEqual({ ok: true, choices: { cards: {}, pays: {}, schedule: {} } });
    expect(parseChoices('{"pays": {"CITI": null}}')).toEqual({ ok: true, choices: { cards: {}, pays: { CITI: null }, schedule: {} } });
  });

  it("refuses what is not JSON, an unknown section, and an answer that is not one of the three", () => {
    expect(parseChoices("{")).toEqual({ ok: false, problems: ["choices.json is not valid JSON"] });
    const unknown = parseChoices('{"card": {}}');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.problems[0]).toMatch(/^choices\.json \(top level\): /);
    const answer = parseChoices('{"schedule": {"CITI-20261120": "maybe"}}');
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.problems[0]).toMatch(/^choices\.json schedule\.CITI-20261120: /);
  });
});

describe("planImport: accounts and balances", () => {
  it("maps every account, with the cushion on the spend account only", async () => {
    const plan = planned(await parsedWorkbook());
    expect(plan.problems).toEqual([]);
    expect(plan.questions).toEqual([]);
    expect(plan.forecastStart).toBe("2026-11-02");
    expect(plan.accounts).toEqual([
      { ref: "ASPEND", name: "Everyday checking", kind: "checking", ownerLabel: "Shared", cushion: "500.00" },
      { ref: "ASAV", name: "Rainy-day savings", kind: "savings", ownerLabel: "Shared", cushion: null },
      { ref: "DPNC", name: "Second checking", kind: "checking", ownerLabel: "Drake", cushion: null },
      { ref: "ALEXCHK", name: "Personal checking", kind: "checking", ownerLabel: "Alexis", cushion: null },
      { ref: "CITI", name: "Card one", kind: "credit_card", ownerLabel: "Drake", cushion: null },
      { ref: "AMEX", name: "Card two", kind: "credit_card", ownerLabel: "Shared", cushion: null },
      { ref: "PNCCC", name: "Card three", kind: "credit_card", ownerLabel: "Alexis", cushion: null },
    ]);
  });

  it("keeps one balance per account and date, the newest winning, and reports each merge", async () => {
    const plan = planned(await parsedWorkbook());
    expect(plan.snapshots).toEqual([
      { accountRef: "ALEXCHK", asOfDate: "2026-11-02", balance: "300.00" },
      { accountRef: "ASAV", asOfDate: "2026-11-02", balance: "5000.00" },
      { accountRef: "ASPEND", asOfDate: "2026-11-02", balance: "2000.00" },
      { accountRef: "CITI", asOfDate: "2026-11-02", balance: "400.00" },
      { accountRef: "DPNC", asOfDate: "2026-11-02", balance: "800.00" },
      { accountRef: "PNCCC", asOfDate: "2026-10-31", balance: "175.00" },
      { accountRef: "PNCCC", asOfDate: "2026-11-01", balance: "150.00" },
    ]);
    expect(plan.notes).toContain(
      "ASPEND on 2026-11-02: 2 balances merged; kept 2000.00 from Accounts row 4, the newest; replacing Balance History row 4 (1990.00)",
    );
    expect(plan.notes).toContain(
      "ASAV on 2026-11-02: 2 balances merged; kept 5000.00 from Accounts row 5, the newest; the same value in Balance History row 6 (5000.00)",
    );
  });

  it("refuses a balance dated after today, and keeps one dated after the forecast start", async () => {
    const plan = planned(
      await parsedWorkbook((spec) => {
        spec.Accounts.rows[2][5] = day("2026-11-03");
        spec["Balance History"].rows[1][2] = day("2026-11-10");
      }),
      STANDARD_CHOICES,
      "2026-11-05",
    );
    expect(plan.problems).toEqual(["Balance History row 5: the balance is dated 2026-11-10, after today (2026-11-05)"]);
    expect(plan.snapshots).toContainEqual(expect.objectContaining({ accountRef: "DPNC", asOfDate: "2026-11-03" }));
  });

  it("refuses a balance for an account that is not in the Accounts sheet", async () => {
    const plan = planned(await parsedWorkbook((spec) => (spec["Balance History"].rows[0][1] = "NOPE")));
    expect(plan.problems).toEqual(["Balance History row 4: Account ID NOPE is not in the Accounts sheet"]);
  });

  it("needs the four accounts the pay is split into", async () => {
    const plan = planned(await parsedWorkbook((spec) => (spec.Accounts.rows[3][0] = "OTHER")));
    expect(plan.problems).toEqual(["Accounts: the pay split needs a personal account with Account ID ALEXCHK"]);
  });
});

describe("planImport: pay", () => {
  it("makes weekly pay from the first payday and twice-monthly pay on the two days, savings taking the rest", async () => {
    const plan = planned(await parsedWorkbook());
    expect(plan.rules.slice(0, 2)).toEqual([
      {
        ref: "PAY-DRAKE",
        name: "Drake pay",
        kind: "INCOME",
        category: null,
        notes: "Drake first payday: UNCONFIRMED",
        paysAccountRef: null,
        scheduled: false,
        versions: [
          {
            recurrence: "WEEKLY",
            interval: 1,
            anchorDate: "2026-11-06",
            dayOfMonth: null,
            secondDay: null,
            effectiveFrom: "2026-11-02",
            effectiveTo: null,
            amount: "1000.00",
            note: null,
            allocations: [
              { accountRef: "ASPEND", mode: "PERCENT", value: "60" },
              { accountRef: "DPNC", mode: "PERCENT", value: "10" },
              { accountRef: "ASAV", mode: "REMAINDER", value: null },
            ],
          },
        ],
      },
      {
        ref: "PAY-ALEXIS",
        name: "Alexis pay",
        kind: "INCOME",
        category: null,
        notes: null,
        paysAccountRef: null,
        scheduled: false,
        versions: [
          {
            recurrence: "TWICE_MONTHLY",
            interval: 1,
            anchorDate: "2026-11-15",
            dayOfMonth: 15,
            secondDay: 30,
            effectiveFrom: "2026-11-02",
            effectiveTo: null,
            amount: "1500.00",
            note: null,
            allocations: [
              { accountRef: "ASPEND", mode: "PERCENT", value: "50" },
              { accountRef: "ALEXCHK", mode: "PERCENT", value: "20" },
              { accountRef: "ASAV", mode: "REMAINDER", value: null },
            ],
          },
        ],
      },
    ]);
  });

  it("moves a first payday before the forecast start on by whole weeks", async () => {
    const plan = planned(await parsedWorkbook((spec) => (spec.Settings.rows[4][1] = day("2026-10-23"))));
    expect(rule(plan, "PAY-DRAKE").versions[0].anchorDate).toBe("2026-11-06");
  });

  it("leaves out a zero share and notes shares that do not add up to 100%", async () => {
    const plan = planned(
      await parsedWorkbook((spec) => {
        spec.Settings.rows[6][1] = 0; // Drake PNC share
      }),
    );
    expect(rule(plan, "PAY-DRAKE").versions[0].allocations.map((a) => a.accountRef)).toEqual(["ASPEND", "ASAV"]);
    expect(plan.notes).toContain("Drake pay: the shares add up to 90%; savings takes the rest (40%)");
  });

  it("refuses shares over 100%", async () => {
    const plan = planned(await parsedWorkbook((spec) => (spec.Settings.rows[5][1] = 0.95)));
    expect(plan.problems).toEqual(["Settings (Drake pay): over_allocated"]);
  });

  it("makes a filled-in pay change a second version", async () => {
    const plan = planned(
      await parsedWorkbook((spec) => {
        spec.Settings.rows[14][1] = day("2026-12-01"); // Drake changed pay effective
        spec.Settings.rows[15][1] = 1100;
      }),
    );
    const versions = rule(plan, "PAY-DRAKE").versions;
    expect(versions.map((v) => [v.effectiveFrom, v.effectiveTo, v.anchorDate, v.amount])).toEqual([
      ["2026-11-02", "2026-11-30", "2026-11-06", "1000.00"],
      ["2026-12-01", null, "2026-12-04", "1100.00"],
    ]);
    expect(versions[1].allocations).toEqual(versions[0].allocations);
  });

  it("refuses half a pay change, or one that is not after the forecast start", async () => {
    const half = planned(await parsedWorkbook((spec) => (spec.Settings.rows[17][1] = 1600)));
    expect(half.problems).toEqual(["Settings (Alexis pay): a pay change needs both its date and its new amount"]);
    const early = planned(
      await parsedWorkbook((spec) => {
        spec.Settings.rows[16][1] = day("2026-11-02");
        spec.Settings.rows[17][1] = 1600;
      }),
    );
    expect(early.problems).toEqual(["Settings (Alexis pay): the pay change on 2026-11-02 cannot be made (change_not_after_start)"]);
  });
});

describe("planImport: bills", () => {
  it("maps each frequency, anchored on its first schedule date on or after the forecast start", async () => {
    const plan = planned(await parsedWorkbook());
    const pattern = (ref: string) => {
      const { recurrence, interval, anchorDate, dayOfMonth, effectiveFrom } = rule(plan, ref).versions[0];
      return { recurrence, interval, anchorDate, dayOfMonth, effectiveFrom };
    };
    expect(pattern("MORT")).toEqual({ recurrence: "MONTHLY", interval: 1, anchorDate: "2026-12-01", dayOfMonth: 1, effectiveFrom: "2026-11-02" });
    expect(pattern("DAYCARE")).toEqual({ recurrence: "WEEKLY", interval: 1, anchorDate: "2026-11-06", dayOfMonth: null, effectiveFrom: "2026-11-02" });
    // Semiannual is every 6 months; with no due day, on its first schedule date's day.
    expect(pattern("INS")).toEqual({ recurrence: "MONTHLY", interval: 6, anchorDate: "2026-12-15", dayOfMonth: 15, effectiveFrom: "2026-11-02" });
    expect(pattern("CITI")).toEqual({ recurrence: "MONTHLY", interval: 1, anchorDate: "2026-11-20", dayOfMonth: 20, effectiveFrom: "2026-11-02" });
  });

  it("pays a direct bill from the account its row names, and labels card payments as answered", async () => {
    const plan = planned(await parsedWorkbook());
    expect(rule(plan, "MORT")).toMatchObject({
      kind: "BILL",
      name: "Home loan",
      category: "Housing",
      notes: "Method: Autopay; Fixed rate",
      paysAccountRef: null,
      scheduled: true,
    });
    expect(rule(plan, "MORT").versions[0]).toMatchObject({ amount: "1200.00", allocations: [{ accountRef: "ASPEND", mode: "REMAINDER", value: null }] });
    expect(rule(plan, "INS").versions[0].allocations[0].accountRef).toBe("DPNC");
    expect(rule(plan, "CITI").paysAccountRef).toBe("CITI");
    expect(rule(plan, "PNCCARD").paysAccountRef).toBe("PNCCC");
  });

  it("puts a bill included in a card payment on the answered card, anchored from the forecast start when it has no schedule rows", async () => {
    const plan = planned(await parsedWorkbook());
    expect(rule(plan, "STREAM")).toMatchObject({ scheduled: false, paysAccountRef: null });
    expect(rule(plan, "STREAM").versions[0]).toMatchObject({
      recurrence: "MONTHLY",
      dayOfMonth: 9,
      anchorDate: "2026-11-09",
      allocations: [{ accountRef: "AMEX", mode: "REMAINDER", value: null }],
    });
    expect(rule(plan, "GYM").versions[0]).toMatchObject({ anchorDate: "2026-11-05", allocations: [{ accountRef: "CITI" }] });
    expect(plan.notes).toContain("STREAM: no Bill Schedule date to anchor on; anchored from the forecast start");
  });

  it("anchors weekly and semiannual bills with no schedule rows from the forecast start", async () => {
    const plan = planned(
      await parsedWorkbook((spec) => {
        spec.Bills.rows[5][4] = "Weekly";
        spec.Bills.rows[5][7] = null;
        spec.Bills.rows[6][4] = "Semiannual";
        spec.Bills.rows[6][7] = null;
      }),
    );
    expect(rule(plan, "STREAM").versions[0]).toMatchObject({ recurrence: "WEEKLY", anchorDate: "2026-11-02" });
    expect(rule(plan, "GYM").versions[0]).toMatchObject({ recurrence: "MONTHLY", interval: 6, dayOfMonth: 2, anchorDate: "2026-11-02" });
  });

  it("refuses a payment account that is not an account name", async () => {
    const plan = planned(await parsedWorkbook((spec) => (spec.Bills.rows[0][5] = "Old bank")));
    expect(plan.problems).toEqual([
      'Bills row 4 (MORT): the payment account "Old bank" is not an account name in the Accounts sheet',
    ]);
  });
});

describe("planImport: questions and answers", () => {
  it("asks which card, which card a card payment pays, and what to do with each schedule amount that differs", async () => {
    const plan = planned(await parsedWorkbook(), {});
    expect(plan.questions.map((q) => [q.section, q.key])).toEqual([
      ["pays", "CITI"],
      ["pays", "PNCCARD"],
      ["cards", "STREAM"],
      ["cards", "GYM"],
      ["schedule", "CITI-20261120"],
      ["schedule", "PNCCARD-20261125"],
    ]);
    expect(plan.questions[0].prompt).toBe("Card one payment looks like a card payment: which card does it pay (null if none)? Suggested: CITI");
    expect(plan.questions[1].prompt).toMatch(/Suggested: PNCCC$/);
    expect(plan.questions[2]).toEqual({
      section: "cards",
      key: "STREAM",
      prompt: "Streaming (15.49, Monthly) is included in a card payment: which card is it charged to?",
      options: ["CITI", "AMEX", "PNCCC"],
    });
    expect(plan.questions[4].prompt).toBe(
      "CITI-20261120: the schedule has 0.00 on 2026-11-20, the bill 300.00. Skip that occurrence, confirm the schedule's amount, or use the rule's?",
    );
    expect(plan.problems).toEqual([]);
    expect(plan.overrides).toEqual([]);
  });

  it("turns skip and confirm answers into per-date edits, and the rule's amount into none", async () => {
    const workbook = await parsedWorkbook((spec) => (spec["Bill Schedule"].rows[18][4] = 280)); // CITI-20261220
    const plan = planned(workbook, {
      ...STANDARD_CHOICES,
      schedule: { "CITI-20261120": "skip", "PNCCARD-20261125": "rule", "CITI-20261220": "confirm" },
    });
    expect(plan.questions).toEqual([]);
    expect(plan.problems).toEqual([]);
    expect(plan.overrides).toEqual([
      { ruleRef: "CITI", scheduledOn: "2026-11-20", status: "SKIPPED", confirmedAmount: null },
      { ruleRef: "CITI", scheduledOn: "2026-12-20", status: "CONFIRMED", confirmedAmount: "280.00" },
    ]);
  });

  it("refuses answers that do not fit the workbook", async () => {
    const plan = planned(await parsedWorkbook(), {
      cards: { STREAM: "ASPEND", GYM: "CITI", MORT: "CITI" },
      pays: { CITI: "AMEX", PNCCARD: "NOPE", GYM: "CITI", GHOST: null },
      schedule: { "CITI-20261120": "confirm", "PNCCARD-20261125": "skip", "MORT-20261201": "skip" },
    });
    expect(plan.problems).toEqual([
      "choices.json pays.PNCCARD: NOPE is not a credit card Account ID (CITI, AMEX, PNCCC)",
      "choices.json cards.STREAM: ASPEND is not a credit card Account ID (CITI, AMEX, PNCCC)",
      "choices.json pays.GYM: only a bill paid directly can pay a card",
      "choices.json cards.MORT: not a bill that is included in a card payment",
      "choices.json pays.GHOST: not a Bill ID",
      "choices.json schedule.MORT-20261201: not a Bill Schedule row whose amount differs from its bill",
      "choices.json schedule.CITI-20261120: 0.00 cannot be confirmed; skip it or use the rule's amount",
    ]);
    expect(rule(plan, "CITI").paysAccountRef).toBe("AMEX"); // any card may be chosen
  });

  it("passes on the workbook's own reading problems", async () => {
    const plan = planned(await parsedWorkbook((spec) => (spec.Bills.rows[0][3] = "lots")));
    expect(plan.problems).toEqual(["Bills row 4: Amount is not an amount"]);
  });
});
