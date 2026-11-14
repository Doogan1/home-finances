"use client";

import type { ScheduleDraft } from "@/features/rules/form-drafts";
import type { Recurrence } from "@/features/rules/recurrence";

const LABELS: Record<Recurrence, string> = {
  ONCE: "Once",
  WEEKLY: "Every N weeks",
  MONTHLY: "Every N months",
  TWICE_MONTHLY: "Twice a month",
};
const RECURRENCES = Object.keys(LABELS) as Recurrence[];

/** The schedule part of a rule form. Controlled, so forms can preview as the person types. */
export function ScheduleFields({ value, onChange }: { value: ScheduleDraft; onChange: (next: ScheduleDraft) => void }) {
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...value, ...patch });
  const repeats = value.recurrence === "WEEKLY" || value.recurrence === "MONTHLY";
  return (
    <fieldset>
      <legend>Schedule</legend>
      <label>
        Repeats
        <select value={value.recurrence} onChange={(e) => set({ recurrence: e.target.value as Recurrence })}>
          {RECURRENCES.map((recurrence) => (
            <option key={recurrence} value={recurrence}>
              {LABELS[recurrence]}
            </option>
          ))}
        </select>
      </label>
      {repeats && (
        <label>
          {value.recurrence === "WEEKLY" ? "Weeks between" : "Months between"}
          <input inputMode="numeric" value={value.interval} onChange={(e) => set({ interval: e.target.value })} required />
        </label>
      )}
      <label>
        {value.recurrence === "ONCE" ? "Date" : "First date"}
        <input type="date" value={value.anchorDate} onChange={(e) => set({ anchorDate: e.target.value })} required />
      </label>
      {value.recurrence === "MONTHLY" && (
        <label className="checkbox">
          <input type="checkbox" checked={value.lastDay} onChange={(e) => set({ lastDay: e.target.checked })} />
          On the last day of each month <span className="muted">(then the first date must be a month&apos;s last day)</span>
        </label>
      )}
      {value.recurrence === "TWICE_MONTHLY" && (
        <>
          <label>
            First day of the month <span className="muted">(1 to 27)</span>
            <input inputMode="numeric" value={value.dayOfMonth} onChange={(e) => set({ dayOfMonth: e.target.value })} required />
          </label>
          <label>
            Second day <span className="muted">(31 means the last day)</span>
            <input inputMode="numeric" value={value.secondDay} onChange={(e) => set({ secondDay: e.target.value })} required />
          </label>
        </>
      )}
    </fieldset>
  );
}
