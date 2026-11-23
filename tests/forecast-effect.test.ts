import { describe, expect, it } from "vitest";
import { editEffect, withEdit, type EditFields } from "@/features/forecast/effect";
import { edit, forecastInput } from "./helpers/forecast-fixtures";

const fields = (patch: Partial<EditFields> = {}): EditFields => ({ status: "PLANNED", confirmedAmount: null, movedTo: null, ...patch });
const spendLowest = { date: "2026-12-01", cents: 155909n };

describe("editEffect", () => {
  it("skipping the mortgage lifts Ally Spend's lowest point to today's balance", () => {
    expect(editEffect(forecastInput(), "mort", "2026-12-01", fields({ status: "SKIPPED" }))).toEqual([
      { accountId: "spend", accountName: "Ally Spend", before: spendLowest, after: { date: "2026-11-14", cents: 200000n } },
    ]);
  });

  it("a confirmed amount replaces the estimate", () => {
    const [effect] = editEffect(forecastInput(), "mort", "2026-12-01", fields({ status: "CONFIRMED", confirmedAmount: "2500" }));
    expect(effect.after).toEqual({ date: "2026-12-01", cents: 90000n });
  });

  it("moving it before the next payday makes the low point earlier and deeper", () => {
    const [effect] = editEffect(forecastInput(), "mort", "2026-12-01", fields({ movedTo: "2026-11-18" }));
    expect(effect.after).toEqual({ date: "2026-11-18", cents: 15909n });
  });

  it("resetting removes an existing edit", () => {
    const input = forecastInput({ overrides: [edit({ ruleId: "mort", scheduledOn: "2026-12-01", status: "SKIPPED" })] });
    const [effect] = editEffect(input, "mort", "2026-12-01", null);
    expect(effect).toMatchObject({ before: { date: "2026-11-14", cents: 200000n }, after: spendLowest });
  });

  it("covers every forecast account an income touches, unchanged ones included, in forecast order", () => {
    const effects = editEffect(forecastInput(), "pay", "2026-11-20", fields({ status: "SKIPPED" }));
    expect(effects.map((e) => [e.accountId, e.after])).toEqual([
      ["spend", { date: "2026-12-01", cents: 85909n }],
      ["savings", { date: "2026-11-11", cents: 50000n }],
    ]);
    expect(effects[1].before).toEqual(effects[1].after);
  });

  it("is empty for a bill paid from a card, and for a rule that is not in the input", () => {
    expect(editEffect(forecastInput(), "stream", "2026-11-15", fields({ status: "SKIPPED" }))).toEqual([]);
    expect(editEffect(forecastInput(), "nope", "2026-11-15", fields())).toEqual([]);
  });
});

describe("withEdit", () => {
  it("replaces the edit for that date and leaves the rest", () => {
    const keep = edit({ ruleId: "mort", scheduledOn: "2027-01-01", status: "PAID" });
    const input = forecastInput({ overrides: [keep, edit({ ruleId: "mort", scheduledOn: "2026-12-01", status: "SKIPPED" })] });
    expect(withEdit(input, "mort", "2026-12-01", fields({ status: "PAID" })).overrides).toEqual([
      keep,
      { ruleId: "mort", scheduledOn: "2026-12-01", status: "PAID", confirmedAmount: null, movedTo: null },
    ]);
    expect(withEdit(input, "mort", "2026-12-01", null).overrides).toEqual([keep]);
  });
});
