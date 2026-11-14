import { describe, expect, it } from "vitest";
import { fromCents, percentOf, toCents } from "@/lib/cents";

describe("toCents", () => {
  it("reads canonical and stored amounts", () => {
    expect(toCents("1926.94")).toBe(192694n);
    expect(toCents("1926.9400")).toBe(192694n);
    expect(toCents("5")).toBe(500n);
    expect(toCents("0.5")).toBe(50n);
    expect(toCents("-12.4")).toBe(-1240n);
  });
  it("refuses anything finer than a cent, or not a number", () => {
    expect(() => toCents("1.005")).toThrow(RangeError);
    expect(() => toCents("1.00001")).toThrow(RangeError);
    expect(() => toCents("1,000")).toThrow(RangeError);
    expect(() => toCents("abc")).toThrow(RangeError);
  });
});

describe("fromCents", () => {
  it("writes two decimals", () => {
    expect(fromCents(192694n)).toBe("1926.94");
    expect(fromCents(500n)).toBe("5.00");
    expect(fromCents(0n)).toBe("0.00");
    expect(fromCents(-5n)).toBe("-0.05");
  });
});

describe("percentOf", () => {
  it("rounds half up to the cent", () => {
    expect(percentOf(192694n, "70")).toBe(134886n); // 1348.858
    expect(percentOf(192694n, "15")).toBe(28904n); // 289.041
    expect(percentOf(10001n, "50")).toBe(5001n); // 50.005
    expect(percentOf(100n, "33.3333")).toBe(33n);
    expect(percentOf(100n, "100.0000")).toBe(100n);
  });
  it("refuses a negative amount or an unreadable percentage", () => {
    expect(() => percentOf(-1n, "50")).toThrow(RangeError);
    expect(() => percentOf(100n, "-5")).toThrow(RangeError);
  });
});
