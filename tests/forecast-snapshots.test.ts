import { describe, expect, it } from "vitest";
import { latestSnapshots, snapshotDate, type SnapshotRow } from "@/features/forecast/snapshots";

const NY = "America/New_York";
const row = (accountId: string, asOf: string | null, observedAt: string, current = "100"): SnapshotRow => ({
  accountId,
  asOfDate: asOf ? new Date(`${asOf}T00:00:00Z`) : null,
  observedAt: new Date(observedAt),
  current,
});

describe("snapshotDate", () => {
  it("is the as-of date for a hand-entered balance", () => {
    expect(snapshotDate(row("a", "2026-11-10", "2026-11-14T17:00:00Z"), NY)).toBe("2026-11-10");
  });

  it("is the household-local day a bank balance was observed", () => {
    // 03:00 UTC on Nov 15 is still the evening of Nov 14 in New York.
    expect(snapshotDate(row("a", null, "2026-11-15T03:00:00Z"), NY)).toBe("2026-11-14");
    expect(snapshotDate(row("a", null, "2026-11-15T03:00:00Z"), "UTC")).toBe("2026-11-15");
  });
});

describe("latestSnapshots", () => {
  it("picks each account's latest date", () => {
    const latest = latestSnapshots(
      [
        row("a", "2026-11-01", "2026-11-14T17:00:00Z", "1"),
        row("a", "2026-11-10", "2026-11-12T17:00:00Z", "2"),
        row("b", "2026-11-05", "2026-11-05T17:00:00Z", "3"),
      ],
      NY,
    );
    expect(latest.size).toBe(2);
    expect(latest.get("a")).toMatchObject({ accountId: "a", date: "2026-11-10", balance: "2" });
    expect(latest.get("b")).toMatchObject({ accountId: "b", date: "2026-11-05", balance: "3" });
  });

  it("a later date wins even when it was observed earlier", () => {
    const typedLate = row("a", "2026-11-10", "2026-11-14T17:00:00Z", "1");
    const bank = row("a", null, "2026-11-12T15:00:00Z", "2"); // Nov 12 in New York
    expect(latestSnapshots([typedLate, bank], NY).get("a")).toMatchObject({ date: "2026-11-12", balance: "2" });
  });

  it("on the same date the later observation wins, whatever its kind and order", () => {
    const manual = row("a", "2026-11-14", "2026-11-14T20:00:00Z", "1");
    const bank = row("a", null, "2026-11-15T03:00:00Z", "2"); // also Nov 14 in New York, observed later
    expect(latestSnapshots([manual, bank], NY).get("a")?.balance).toBe("2");
    expect(latestSnapshots([bank, manual], NY).get("a")?.balance).toBe("2");

    const earlierBank = row("a", null, "2026-11-14T15:00:00Z", "3"); // Nov 14, observed before the manual one
    expect(latestSnapshots([earlierBank, manual], NY).get("a")?.balance).toBe("1");
  });

  it("has nothing for no rows", () => {
    expect(latestSnapshots([], NY).size).toBe(0);
  });
});
