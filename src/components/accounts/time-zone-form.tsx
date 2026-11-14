"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { postJson } from "../post-json";

const subscribeToNothing = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const noZone = () => null;

/**
 * Offers every IANA zone (the list comes from the server, so server and browser
 * render the same options), preselecting the browser's own zone once it is
 * known. Nothing is saved until the person confirms.
 */
export function TimeZoneForm({ current, zones }: { current: string | null; zones: string[] }) {
  const router = useRouter();
  // null while server-rendering, the browser's zone after hydration.
  const guessed = useSyncExternalStore(subscribeToNothing, browserZone, noZone);
  const [chosen, setChosen] = useState<string | null>(current);
  const value = chosen ?? (guessed && zones.includes(guessed) ? guessed : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!value) return setError("Choose a time zone.");
    setSaving(true);
    const result = await postJson("/api/household/time-zone", { timeZone: value });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    setError(null);
    router.refresh();
  }

  return (
    <form className="form inline-form" onSubmit={save}>
      <label>
        Household time zone
        <select value={value} onChange={(e) => setChosen(e.target.value)}>
          {!value && <option value="">Choose…</option>}
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={saving}>
        Save time zone
      </button>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </form>
  );
}
