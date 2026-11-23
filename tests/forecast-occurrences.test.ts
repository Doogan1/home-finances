import { describe, expect, it } from "vitest";
import { occurrenceAt, occurrencesBetween, orphanEdits } from "@/features/forecast/occurrences";
import { edit, MORTGAGE, rule, version } from "./helpers/forecast-fixtures";

const paycheck = rule({
  id: "pay",
  name: "Paycheck",
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
});

describe("occurrencesBetween", () => {
  it("produces each scheduled date with the version's amount, marked as an estimate", () => {
    const result = occurrencesBetween([rule()], [], "2026-11-01", "2027-01-31");
    expect(result.map((o) => o.date)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(result[0]).toEqual({
      ruleId: "r1",
      ruleName: "Mortgage",
      kind: "BILL",
      versionId: "v1",
      scheduledOn: "2026-11-01",
      date: "2026-11-01",
      status: "PLANNED",
      estimate: true,
      amount: 10000n,
      shares: [{ accountId: "spend", cents: 10000n }],
    });
  });

  it("a confirmed amount replaces the estimate and is split the same way", () => {
    const result = occurrencesBetween(
      [paycheck],
      [edit({ ruleId: "pay", scheduledOn: "2026-12-01", confirmedAmount: "1200.01" })],
      "2026-11-01",
      "2026-12-31",
    );
    expect(result[0]).toMatchObject({
      date: "2026-11-01",
      estimate: true,
      shares: [
        { accountId: "spend", cents: 70000n },
        { accountId: "savings", cents: 30000n },
      ],
    });
    // 70% of $1,200.01 is $840.007, rounded half up to $840.01; savings takes the rest.
    expect(result[1]).toMatchObject({
      date: "2026-12-01",
      estimate: false,
      amount: 120001n,
      shares: [
        { accountId: "spend", cents: 84001n },
        { accountId: "savings", cents: 36000n },
      ],
    });
  });

  it("keeps each edit's status, Skipped included (callers decide what counts)", () => {
    const result = occurrencesBetween(
      [rule()],
      [edit({ scheduledOn: "2026-11-01", status: "PAID" }), edit({ scheduledOn: "2026-12-01", status: "SKIPPED" })],
      "2026-11-01",
      "2027-01-31",
    );
    expect(result.map((o) => o.status)).toEqual(["PAID", "SKIPPED", "PLANNED"]);
  });

  it("a moved occurrence counts on its new date, even when it was scheduled outside the range", () => {
    const early = rule({ versions: [version({ effectiveFrom: "2026-10-01", anchorDate: "2026-10-01" })] });
    const result = occurrencesBetween(
      [early],
      [
        edit({ scheduledOn: "2026-10-01", movedTo: "2026-11-03" }), // moved into the range
        edit({ scheduledOn: "2026-12-01", movedTo: "2027-01-02" }), // moved out of it
        edit({ scheduledOn: "2026-10-15", movedTo: "2026-11-20" }), // a date the rule does not produce
      ],
      "2026-11-01",
      "2026-12-31",
    );
    expect(result.map((o) => [o.scheduledOn, o.date])).toEqual([
      ["2026-11-01", "2026-11-01"],
      ["2026-10-01", "2026-11-03"],
    ]);
  });

  it("the version in effect on the scheduled date sets the amount, including on the change date", () => {
    const changed = rule({
      versions: [
        version({ id: "v1", effectiveTo: "2026-11-30" }),
        version({ id: "v2", effectiveFrom: "2026-12-01", anchorDate: "2026-12-01", amount: "120" }),
      ],
    });
    const result = occurrencesBetween([changed], [], "2026-11-01", "2027-01-31");
    expect(result.map((o) => [o.date, o.versionId, o.amount])).toEqual([
      ["2026-11-01", "v1", 10000n],
      ["2026-12-01", "v2", 12000n],
      ["2027-01-01", "v2", 12000n],
    ]);
  });

  it("orders by date, then by rule name", () => {
    const result = occurrencesBetween(
      [rule({ id: "w", name: "Water" }), rule({ id: "e", name: "Electric" })],
      [],
      "2026-11-01",
      "2026-11-01",
    );
    expect(result.map((o) => o.ruleName)).toEqual(["Electric", "Water"]);
  });

  it("ignores edits of rules it was not given", () => {
    const result = occurrencesBetween(
      [rule()],
      [edit({ ruleId: "other", scheduledOn: "2026-11-01", status: "SKIPPED" })],
      "2026-11-01",
      "2026-11-01",
    );
    expect(result.map((o) => o.status)).toEqual(["PLANNED"]);
  });
});

describe("orphanEdits", () => {
  it("lists edits whose date the rule no longer produces", () => {
    const result = orphanEdits(
      [rule()],
      [
        edit({ scheduledOn: "2026-12-01" }),
        edit({ scheduledOn: "2026-11-15" }),
        edit({ ruleId: "gone", scheduledOn: "2026-11-15" }),
      ],
    );
    expect(result).toEqual([{ ruleId: "r1", ruleName: "Mortgage", scheduledOn: "2026-11-15" }]);
  });
});

describe("occurrenceAt", () => {
  it("is the occurrence the rule produces on that date, with its edit applied", () => {
    const confirmed = edit({ ruleId: "mort", scheduledOn: "2026-12-01", status: "CONFIRMED", confirmedAmount: "1900" });
    expect(occurrenceAt(MORTGAGE, [confirmed], "2026-12-01")).toMatchObject({
      ruleId: "mort",
      scheduledOn: "2026-12-01",
      date: "2026-12-01",
      status: "CONFIRMED",
      estimate: false,
      amount: 190000n,
    });
  });

  it("keeps the scheduled date as its identity when the edit moves it", () => {
    const moved = edit({ ruleId: "mort", scheduledOn: "2026-12-01", movedTo: "2026-12-03" });
    expect(occurrenceAt(MORTGAGE, [moved], "2026-12-01")).toMatchObject({ scheduledOn: "2026-12-01", date: "2026-12-03" });
  });

  it("is null on a date the rule does not produce, and ignores other rules' edits", () => {
    expect(occurrenceAt(MORTGAGE, [], "2026-12-02")).toBeNull();
    const otherRule = edit({ ruleId: "r1", scheduledOn: "2026-12-01", status: "SKIPPED" });
    expect(occurrenceAt(MORTGAGE, [otherRule], "2026-12-01")).toMatchObject({ status: "PLANNED", estimate: true, amount: 184091n });
  });
});
