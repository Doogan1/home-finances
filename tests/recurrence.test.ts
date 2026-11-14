import { describe, expect, it } from "vitest";
import {
  clampedDay,
  daysInMonth,
  firstOnOrAfter,
  nextOccurrences,
  patternDates,
  ruleOccurrences,
  versionDates,
  type DatedPattern,
  type Pattern,
} from "@/features/rules/recurrence";

const monthly = (anchorDate: string, dayOfMonth: number, interval = 1): Pattern => ({
  recurrence: "MONTHLY",
  interval,
  anchorDate,
  dayOfMonth,
  secondDay: null,
});
const weekly = (anchorDate: string, interval = 1): Pattern => ({
  recurrence: "WEEKLY",
  interval,
  anchorDate,
  dayOfMonth: null,
  secondDay: null,
});
const twice = (dayOfMonth: number, secondDay: number, anchorDate = "2026-11-01"): Pattern => ({
  recurrence: "TWICE_MONTHLY",
  interval: 1,
  anchorDate,
  dayOfMonth,
  secondDay,
});
const once = (anchorDate: string): Pattern => ({ recurrence: "ONCE", interval: 1, anchorDate, dayOfMonth: null, secondDay: null });

describe("month ends", () => {
  it("knows month lengths in leap and ordinary years", () => {
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(clampedDay(2027, 4, 31)).toBe("2027-04-30");
  });

  it("uses the month's last day when it is shorter, so 31 means the last day", () => {
    expect(patternDates(monthly("2027-01-31", 31), "2027-01-01", "2027-05-31")).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
    ]);
    expect(patternDates(monthly("2028-01-31", 31), "2028-02-01", "2028-02-29")).toEqual(["2028-02-29"]);
  });

  it("returns to the real day after a short month", () => {
    expect(patternDates(monthly("2027-01-30", 30), "2027-01-01", "2027-03-31")).toEqual([
      "2027-01-30",
      "2027-02-28",
      "2027-03-30",
    ]);
  });
});

describe("every N from an anchor", () => {
  it("every 6 months (semiannual)", () => {
    expect(patternDates(monthly("2026-11-26", 26, 6), "2026-11-01", "2027-12-31")).toEqual([
      "2026-11-26",
      "2027-05-26",
      "2027-11-26",
    ]);
  });

  it("starts part-way through when the window starts later", () => {
    expect(patternDates(monthly("2026-11-26", 26, 6), "2027-01-01", "2027-06-30")).toEqual(["2027-05-26"]);
    expect(patternDates(monthly("2026-12-01", 1), "2027-02-02", "2027-04-01")).toEqual(["2027-03-01", "2027-04-01"]);
  });

  it("weekly and every two weeks", () => {
    expect(patternDates(weekly("2026-11-20"), "2026-11-21", "2026-12-11")).toEqual([
      "2026-11-27",
      "2026-12-04",
      "2026-12-11",
    ]);
    expect(patternDates(weekly("2026-11-20", 2), "2026-11-20", "2026-12-31")).toEqual([
      "2026-11-20",
      "2026-12-04",
      "2026-12-18",
    ]);
  });

  it("produces nothing before the anchor", () => {
    expect(patternDates(weekly("2026-11-20"), "2026-11-01", "2026-11-19")).toEqual([]);
    expect(patternDates(monthly("2026-12-01", 1), "2026-01-01", "2026-11-30")).toEqual([]);
  });

  it("once is only its own date", () => {
    expect(patternDates(once("2026-12-15"), "2026-12-01", "2026-12-31")).toEqual(["2026-12-15"]);
    expect(patternDates(once("2026-12-15"), "2026-12-16", "2026-12-31")).toEqual([]);
  });
});

describe("twice a month", () => {
  it("produces both days each month", () => {
    expect(patternDates(twice(5, 20), "2026-11-01", "2026-12-31")).toEqual([
      "2026-11-05",
      "2026-11-20",
      "2026-12-05",
      "2026-12-20",
    ]);
  });

  it("applies the month-end rule to the second day", () => {
    expect(patternDates(twice(15, 31, "2027-01-01"), "2027-02-01", "2027-04-30")).toEqual([
      "2027-02-15",
      "2027-02-28",
      "2027-03-15",
      "2027-03-31",
      "2027-04-15",
      "2027-04-30",
    ]);
  });

  it("starts at the anchor", () => {
    expect(patternDates(twice(5, 20, "2026-11-10"), "2026-11-01", "2026-11-30")).toEqual(["2026-11-20"]);
  });
});

describe("versions", () => {
  const v1: DatedPattern = { ...weekly("2026-11-20"), effectiveFrom: "2026-11-20", effectiveTo: "2026-12-31" };
  const v2: DatedPattern = { ...weekly("2027-01-01"), effectiveFrom: "2027-01-01", effectiveTo: null };

  it("keeps each version inside its own dates", () => {
    expect(versionDates(v1, "2026-12-20", "2027-01-31")).toEqual(["2026-12-25"]);
    expect(versionDates(v2, "2026-12-01", "2026-12-31")).toEqual([]);
  });

  it("gives an occurrence exactly on the change date to the new version", () => {
    const result = ruleOccurrences([v2, v1], "2026-12-24", "2027-01-08");
    expect(result.map((o) => [o.date, o.version === v1 ? "v1" : "v2"])).toEqual([
      ["2026-12-25", "v1"],
      ["2027-01-01", "v2"],
      ["2027-01-08", "v2"],
    ]);
  });

  it("lists the next occurrences across versions", () => {
    expect(nextOccurrences([v1, v2], "2026-12-30", 3).map((o) => o.date)).toEqual([
      "2027-01-01",
      "2027-01-08",
      "2027-01-15",
    ]);
  });

  it("finds the first date on or after a day", () => {
    expect(firstOnOrAfter(weekly("2026-11-20"), "2027-01-02")).toBe("2027-01-08");
    expect(firstOnOrAfter(weekly("2026-11-20"), "2027-01-01")).toBe("2027-01-01");
    expect(firstOnOrAfter(monthly("2026-11-26", 26, 6), "2026-11-27")).toBe("2027-05-26");
    expect(firstOnOrAfter(monthly("2026-11-26", 26, 24), "2026-11-27")).toBe("2028-11-26");
    expect(firstOnOrAfter(once("2026-12-15"), "2026-12-16")).toBeNull();
  });
});
