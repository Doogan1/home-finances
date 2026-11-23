"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "../post-json";

/** Did the balance include it? Cleared marks it paid; Still pending moves it to the day after the balance. */
export function ClearButtons({ ruleId, scheduledOn, accountId }: { ruleId: string; scheduledOn: string; accountId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function answer(value: "cleared" | "pending") {
    setSaving(true);
    const result = await postJson(`/api/rules/${ruleId}/occurrences/${scheduledOn}/clear`, { accountId, answer: value });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    router.refresh();
  }

  return (
    <span className="actions">
      <button type="button" disabled={saving} onClick={() => answer("cleared")}>
        Cleared
      </button>
      <button type="button" disabled={saving} onClick={() => answer("pending")}>
        Still pending
      </button>
      {error && (
        <span role="alert" className="form-error">
          {error}
        </span>
      )}
    </span>
  );
}
