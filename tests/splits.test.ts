import { describe, expect, it } from "vitest";
import { SplitError, splitAmount, type AllocationLike } from "@/features/rules/splits";

const pct = (accountId: string, value: string): AllocationLike => ({ accountId, mode: "PERCENT", value });
const fixed = (accountId: string, value: string): AllocationLike => ({ accountId, mode: "FIXED", value });
const rest = (accountId: string): AllocationLike => ({ accountId, mode: "REMAINDER", value: null });

describe("splitAmount", () => {
  it("rounds percentages half up and gives the rest to the remainder, so shares add up exactly", () => {
    const shares = splitAmount(192694n, [pct("spend", "70"), pct("pnc", "15"), rest("savings")]);
    expect(shares).toEqual([
      { accountId: "spend", cents: 134886n },
      { accountId: "pnc", cents: 28904n },
      { accountId: "savings", cents: 28904n },
    ]);
    expect(shares.reduce((sum, s) => sum + s.cents, 0n)).toBe(192694n);
  });

  it("rounds a half cent up", () => {
    expect(splitAmount(10001n, [pct("a", "50"), rest("b")])).toEqual([
      { accountId: "a", cents: 5001n },
      { accountId: "b", cents: 5000n },
    ]);
  });

  it("mixes fixed amounts and percentages", () => {
    expect(splitAmount(100000n, [fixed("a", "200"), pct("b", "10"), rest("c")]).map((s) => s.cents)).toEqual([
      20000n,
      10000n,
      70000n,
    ]);
  });

  it("gives a single remainder the whole amount, and allows a remainder of zero", () => {
    expect(splitAmount(184091n, [rest("spend")])).toEqual([{ accountId: "spend", cents: 184091n }]);
    expect(splitAmount(10000n, [pct("a", "100"), rest("b")]).map((s) => s.cents)).toEqual([10000n, 0n]);
  });

  it("keeps the order it was given", () => {
    expect(splitAmount(1000n, [rest("z"), pct("a", "10")]).map((s) => s.accountId)).toEqual(["z", "a"]);
  });

  it("refuses shares that add up to more than the amount", () => {
    expect(() => splitAmount(10000n, [fixed("a", "150"), rest("b")])).toThrow(SplitError);
    expect(() => splitAmount(10000n, [pct("a", "60"), pct("b", "50"), rest("c")])).toThrow(
      expect.objectContaining({ code: "over_allocated" }),
    );
  });

  it("needs exactly one remainder", () => {
    expect(() => splitAmount(10000n, [pct("a", "100")])).toThrow(expect.objectContaining({ code: "needs_one_remainder" }));
    expect(() => splitAmount(10000n, [rest("a"), rest("b")])).toThrow(expect.objectContaining({ code: "needs_one_remainder" }));
    expect(() => splitAmount(10000n, [])).toThrow(expect.objectContaining({ code: "needs_one_remainder" }));
  });
});
