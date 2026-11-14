import { describe, expect, it } from "vitest";
import { parseMoney } from "@/lib/money";

describe("parseMoney", () => {
  it("normalises what people type", () => {
    expect(parseMoney("2431.07", { allowNegative: false })).toBe("2431.07");
    expect(parseMoney(" $1,500 ", { allowNegative: false })).toBe("1500");
    expect(parseMoney("0012.5", { allowNegative: false })).toBe("12.5");
    expect(parseMoney("0", { allowNegative: false })).toBe("0");
    expect(parseMoney("-$12.40", { allowNegative: true })).toBe("-12.40");
    expect(parseMoney("-0", { allowNegative: true })).toBe("0");
  });

  it("refuses more than two decimal places, bad grouping and junk", () => {
    for (const bad of ["12.345", "1,23", "1,2345", "1.2.3", "abc", "", "$", "1e5", "Infinity", "12.", ".5", "1234567890123456"]) {
      expect(parseMoney(bad, { allowNegative: true }), bad).toBeNull();
    }
  });

  it("refuses negatives unless allowed", () => {
    expect(parseMoney("-5", { allowNegative: false })).toBeNull();
  });
});
