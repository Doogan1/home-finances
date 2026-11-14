import { describe, expect, it } from "vitest";
import {
  allocationBodies,
  allocationsForPreview,
  amountForPreview,
  emptySchedule,
  patternFromDraft,
  scheduleBody,
  scheduleDraftFrom,
} from "@/features/rules/form-drafts";
import { toPattern } from "@/features/rules/input";
import type { Pattern } from "@/features/rules/recurrence";

describe("schedule drafts", () => {
  it("repeats monthly on the first date's day, or on the last day", () => {
    const draft = { ...emptySchedule("MONTHLY"), anchorDate: "2026-12-01" };
    expect(scheduleBody(draft)).toEqual({ recurrence: "MONTHLY", interval: 1, anchorDate: "2026-12-01", dayOfMonth: 1 });
    expect(scheduleBody({ ...draft, anchorDate: "2026-11-30", lastDay: true })).toMatchObject({ dayOfMonth: 31 });
    expect(scheduleBody({ ...draft, interval: "6" })).toMatchObject({ interval: 6 });
  });

  it("is incomplete without a date or with a zero interval", () => {
    expect(scheduleBody(emptySchedule("WEEKLY"))).toBeNull();
    expect(scheduleBody({ ...emptySchedule("WEEKLY"), anchorDate: "2026-11-20", interval: "0" })).toBeNull();
    expect(scheduleBody({ ...emptySchedule("WEEKLY"), anchorDate: "2026-11-20", interval: "" })).toBeNull();
  });

  it("writes the other kinds", () => {
    expect(scheduleBody({ ...emptySchedule("WEEKLY"), anchorDate: "2026-11-20", interval: "2" })).toEqual({
      recurrence: "WEEKLY",
      interval: 2,
      anchorDate: "2026-11-20",
    });
    expect(scheduleBody({ ...emptySchedule("ONCE"), anchorDate: "2026-12-15" })).toEqual({ recurrence: "ONCE", anchorDate: "2026-12-15" });
    expect(
      scheduleBody({ ...emptySchedule("TWICE_MONTHLY"), anchorDate: "2026-11-05", dayOfMonth: "5", secondDay: "20" }),
    ).toEqual({ recurrence: "TWICE_MONTHLY", anchorDate: "2026-11-05", dayOfMonth: 5, secondDay: 20 });
  });

  it("round-trips a stored pattern through a draft", () => {
    const patterns: Pattern[] = [
      { recurrence: "MONTHLY", interval: 1, anchorDate: "2026-12-01", dayOfMonth: 1, secondDay: null },
      { recurrence: "MONTHLY", interval: 1, anchorDate: "2026-11-30", dayOfMonth: 31, secondDay: null },
      { recurrence: "MONTHLY", interval: 1, anchorDate: "2027-02-28", dayOfMonth: 30, secondDay: null },
      { recurrence: "WEEKLY", interval: 2, anchorDate: "2026-11-20", dayOfMonth: null, secondDay: null },
      { recurrence: "TWICE_MONTHLY", interval: 1, anchorDate: "2026-11-05", dayOfMonth: 5, secondDay: 20 },
    ];
    for (const pattern of patterns) expect(patternFromDraft(scheduleDraftFrom(pattern))).toEqual(pattern);
  });

  it("matches what the server stores", () => {
    const body = scheduleBody({ ...emptySchedule("MONTHLY"), anchorDate: "2026-12-01" });
    expect(body && toPattern(body)).toEqual(patternFromDraft({ ...emptySchedule("MONTHLY"), anchorDate: "2026-12-01" }));
  });
});

describe("allocation drafts", () => {
  const rows = [
    { accountId: "spend", mode: "PERCENT" as const, value: " 70 " },
    { accountId: "", mode: "PERCENT" as const, value: "5" },
    { accountId: "savings", mode: "REMAINDER" as const, value: "ignored" },
  ];

  it("drops rows with no account and sends no value for the rest", () => {
    expect(allocationBodies(rows)).toEqual([
      { accountId: "spend", mode: "PERCENT", value: "70" },
      { accountId: "savings", mode: "REMAINDER" },
    ]);
  });

  it("reads typed values for the preview, or gives up until they are readable", () => {
    expect(allocationsForPreview(rows)).toEqual([
      { accountId: "spend", mode: "PERCENT", value: "70" },
      { accountId: "savings", mode: "REMAINDER", value: null },
    ]);
    expect(allocationsForPreview([{ accountId: "spend", mode: "FIXED", value: "1,500" }])).toEqual([
      { accountId: "spend", mode: "FIXED", value: "1500" },
    ]);
    expect(allocationsForPreview([{ accountId: "spend", mode: "FIXED", value: "abc" }])).toBeNull();
  });

  it("reads a preview amount only when it is positive", () => {
    expect(amountForPreview("$1,826.94")).toBe("1826.94");
    expect(amountForPreview("0")).toBeNull();
    expect(amountForPreview("")).toBeNull();
  });
});
