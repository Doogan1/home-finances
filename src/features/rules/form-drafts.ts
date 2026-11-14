import { parseIsoDate } from "@/lib/calendar-date";
import { parseMoney } from "@/lib/money";
import { toPattern, type ScheduleBody } from "./input";
import type { Pattern, Recurrence } from "./recurrence";
import type { AllocationLike, AllocationMode } from "./splits";

/**
 * What the rule forms hold while someone types, and how that becomes a request
 * body (checked again by the server) or a pattern for a live preview.
 */

export type AccountChoice = { id: string; name: string; type: string };

export type ScheduleDraft = {
  recurrence: Recurrence;
  interval: string;
  anchorDate: string;
  lastDay: boolean;
  dayOfMonth: string;
  secondDay: string;
};

export function emptySchedule(recurrence: Recurrence = "MONTHLY"): ScheduleDraft {
  return { recurrence, interval: "1", anchorDate: "", lastDay: false, dayOfMonth: "1", secondDay: "15" };
}

export function scheduleDraftFrom(pattern: Pattern): ScheduleDraft {
  return {
    recurrence: pattern.recurrence,
    interval: String(pattern.interval),
    anchorDate: pattern.anchorDate,
    lastDay: pattern.recurrence === "MONTHLY" && pattern.dayOfMonth === 31,
    dayOfMonth: String(pattern.dayOfMonth ?? 1),
    secondDay: String(pattern.secondDay ?? 15),
  };
}

const wholeNumber = (text: string): number | null => (/^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : null);

/** The request body for a schedule, or null while it is incomplete. The server checks the limits. */
export function scheduleBody(draft: ScheduleDraft): ScheduleBody | null {
  if (!parseIsoDate(draft.anchorDate)) return null;
  const anchorDate = draft.anchorDate;
  const interval = wholeNumber(draft.interval);
  switch (draft.recurrence) {
    case "ONCE":
      return { recurrence: "ONCE", anchorDate };
    case "WEEKLY":
      return interval ? { recurrence: "WEEKLY", interval, anchorDate } : null;
    case "MONTHLY":
      // A monthly schedule repeats on its first date's day, or on the last day of each month.
      return interval
        ? { recurrence: "MONTHLY", interval, anchorDate, dayOfMonth: draft.lastDay ? 31 : Number(anchorDate.slice(8, 10)) }
        : null;
    case "TWICE_MONTHLY": {
      const first = wholeNumber(draft.dayOfMonth);
      const second = wholeNumber(draft.secondDay);
      return first && second ? { recurrence: "TWICE_MONTHLY", anchorDate, dayOfMonth: first, secondDay: second } : null;
    }
  }
}

export function patternFromDraft(draft: ScheduleDraft): Pattern | null {
  const body = scheduleBody(draft);
  return body ? toPattern(body) : null;
}

export type AllocationDraft = { accountId: string; mode: AllocationMode; value: string };
export type AllocationBody = { accountId: string; mode: "PERCENT" | "FIXED"; value: string } | { accountId: string; mode: "REMAINDER" };

export function allocationDraftsFrom(allocations: readonly AllocationLike[]): AllocationDraft[] {
  return allocations.map((a) => ({ accountId: a.accountId, mode: a.mode, value: a.value ?? "" }));
}

export function allocationBodies(rows: readonly AllocationDraft[]): AllocationBody[] {
  return rows
    .filter((row) => row.accountId !== "")
    .map((row) =>
      row.mode === "REMAINDER"
        ? { accountId: row.accountId, mode: "REMAINDER" as const }
        : { accountId: row.accountId, mode: row.mode, value: row.value.trim() },
    );
}

/** Allocations for a live preview, or null until every typed value is readable. */
export function allocationsForPreview(rows: readonly AllocationDraft[]): AllocationLike[] | null {
  const allocations: AllocationLike[] = [];
  for (const row of allocationBodies(rows)) {
    if (row.mode === "REMAINDER") {
      allocations.push({ accountId: row.accountId, mode: "REMAINDER", value: null });
      continue;
    }
    const value = parseMoney(row.value, { allowNegative: false });
    if (value === null) return null;
    allocations.push({ accountId: row.accountId, mode: row.mode, value });
  }
  return allocations;
}

export function amountForPreview(text: string): string | null {
  const amount = parseMoney(text, { allowNegative: false });
  return amount === null || amount === "0" ? null : amount;
}
