import { describe, expect, it } from "vitest";
import { occurrenceHref, safeBack } from "@/components/forecast/occurrence-link";

const ID = "0b9f2a52-9c39-4d3e-8a6e-0b1c2d3e4f50";

describe("safeBack", () => {
  it("keeps this app's own views, with only the account and month", () => {
    expect(safeBack("/")).toBe("/");
    expect(safeBack(`/register?account=${ID}`)).toBe(`/register?account=${ID}`);
    expect(safeBack(`/calendar?account=${ID}&month=2026-12&x=1`)).toBe(`/calendar?account=${ID}&month=2026-12`);
    expect(safeBack(`/register?month=2026-12`)).toBe("/register");
    expect(safeBack(`/bills/${ID}`)).toBe(`/bills/${ID}`);
    expect(safeBack("/accounts/did-it-clear")).toBe("/accounts/did-it-clear");
  });

  it("sends anything else home", () => {
    for (const raw of [undefined, null, "", "https://evil.example/", "//evil.example", "/\\evil.example", "/admin", "/bills/not-a-uuid", "javascript:alert(1)", `/register?account=nope`]) {
      expect(safeBack(raw).startsWith("/")).toBe(true);
      expect(["/", "/register"]).toContain(safeBack(raw));
    }
    expect(safeBack("https://evil.example/register")).toBe("/");
  });
});

describe("occurrenceHref", () => {
  it("names the rule and the scheduled date, and carries a safe way back", () => {
    expect(occurrenceHref(ID, "2026-12-01", `/register?account=${ID}`)).toBe(
      `/occurrences/${ID}/2026-12-01?back=${encodeURIComponent(`/register?account=${ID}`)}`,
    );
    expect(occurrenceHref(ID, "2026-12-01", "https://evil.example")).toBe(`/occurrences/${ID}/2026-12-01?back=%2F`);
  });
});
