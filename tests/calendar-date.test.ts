import { describe, expect, it } from "vitest";
import { daysBetween, isTimeZone, parseIsoDate, toIsoDate, todayIn } from "@/lib/calendar-date";

describe("parseIsoDate", () => {
  it("reads a real date as UTC midnight", () => {
    expect(parseIsoDate("2026-11-14")?.toISOString()).toBe("2026-11-14T00:00:00.000Z");
    expect(parseIsoDate("2028-02-29")?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("refuses impossible dates and other formats", () => {
    for (const bad of ["2026-02-29", "2026-13-01", "2026-11-31", "2026-1-5", "11/14/2026", "2026-11-14T00:00:00Z", "", "0050-01-01"]) {
      expect(parseIsoDate(bad), bad).toBeNull();
    }
  });
});

describe("toIsoDate and daysBetween", () => {
  it("round-trips and counts calendar days", () => {
    expect(toIsoDate(parseIsoDate("2026-12-01")!)).toBe("2026-12-01");
    expect(daysBetween("2026-11-14", "2026-11-21")).toBe(7);
    expect(daysBetween("2026-11-21", "2026-11-14")).toBe(-7);
    // Across the US daylight-saving change (Nov 1, 2026): still whole days.
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
  });
});

describe("todayIn", () => {
  it("uses the household's time zone, not the server's", () => {
    const now = new Date("2026-11-15T03:30:00Z"); // 10:30 pm on Nov 14 in New York
    expect(todayIn("America/New_York", now)).toBe("2026-11-14");
    expect(todayIn("Europe/Berlin", now)).toBe("2026-11-15");
  });
});

describe("isTimeZone", () => {
  it("accepts IANA names and refuses anything else", () => {
    expect(isTimeZone("America/New_York")).toBe(true);
    expect(isTimeZone("America/Detroit")).toBe(true);
    for (const bad of ["", "Mars/Olympus_Mons", "EST5EDT; drop table", "america/new_york"]) {
      expect(isTimeZone(bad), bad).toBe(false);
    }
  });
});
