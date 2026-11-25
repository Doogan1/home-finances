"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "../post-json";

/** Switches a bill between a fixed amount and one that follows its real payments. */
export function EstimateModeForm({ ruleId, mode }: { ruleId: string; mode: "FIXED" | "VARIES" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const next = mode === "FIXED" ? "VARIES" : "FIXED";

  async function change() {
    setSaving(true);
    setError(null);
    const result = await postJson(`/api/rules/${ruleId}/update`, { estimateMode: next });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    router.refresh();
  }

  return (
    <p className="actions">
      <button type="button" onClick={change} disabled={saving}>
        {next === "VARIES" ? "Let the amount vary" : "Keep the amount fixed"}
      </button>
      {error && (
        <span role="alert" className="form-error">
          {error}
        </span>
      )}
    </p>
  );
}
