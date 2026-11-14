"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ruleOccurrences } from "@/features/rules/recurrence";
import { formatIsoDate, latestVersion } from "@/features/rules/summary";
import type { StoredVersion } from "@/features/rules/versions";
import { parseIsoDate } from "@/lib/calendar-date";
import { postJson } from "../post-json";

/** Stop on a date, such as leaving a job. Shows the last date that will still happen. */
export function StopForm({ ruleId, versions, today }: { ruleId: string; versions: StoredVersion[]; today: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const lastDate = useMemo(() => {
    if (!parseIsoDate(on)) return null;
    const dates = ruleOccurrences(versions, latestVersion(versions).effectiveFrom, on);
    return dates.length > 0 ? dates[dates.length - 1].date : null;
  }, [on, versions]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOn(today);
          setError(null);
          setOpen(true);
        }}
      >
        Stop on…
      </button>
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    const result = await postJson(`/api/rules/${ruleId}/stop`, { on });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    setOpen(false);
    router.refresh();
  }

  return (
    <form className="form card" onSubmit={submit}>
      <h3>Stop on…</h3>
      <label>
        Stop on <span className="muted">(the last day it can happen)</span>
        <input type="date" value={on} onChange={(e) => setOn(e.target.value)} required />
      </label>
      <p className="muted">{lastDate ? `Last date: ${formatIsoDate(lastDate)}` : "No dates left in the latest version by then."}</p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving}>
          Save stop date
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
