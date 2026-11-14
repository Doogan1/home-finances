"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "../post-json";

/** Archive, never delete: the versions and per-date edits stay. */
export function ArchiveRuleButton({ ruleId, name }: { ruleId: string; name: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function archive() {
    if (!window.confirm(`Archive ${name}? Its versions and edits are kept.`)) return;
    setSaving(true);
    const result = await postJson(`/api/rules/${ruleId}/archive`, {});
    setSaving(false);
    if (!result.ok) return setError(result.message);
    router.push("/bills");
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={archive} disabled={saving}>
        Archive
      </button>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </>
  );
}
