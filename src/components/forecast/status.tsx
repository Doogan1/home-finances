import type { OccurrenceStatus } from "@/features/forecast/occurrences";

export const STATUS_LABELS: Record<OccurrenceStatus, string> = { PLANNED: "Planned", CONFIRMED: "Confirmed", PAID: "Paid", SKIPPED: "Skipped" };

/** Nothing for Planned (the usual case); a chip for the rest. */
export function StatusChip({ status }: { status: OccurrenceStatus }) {
  return status === "PLANNED" ? null : <span className="chip chip-muted">{STATUS_LABELS[status]}</span>;
}
