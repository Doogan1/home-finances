"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "../post-json";

export function NewAccountForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Add an account
      </button>
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSaving(true);
    const result = await postJson("/api/accounts", {
      name: String(data.get("name") ?? ""),
      kind: String(data.get("kind") ?? ""),
      ownerLabel: String(data.get("ownerLabel") ?? ""),
      cushion: String(data.get("cushion") ?? ""),
    });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    setOpen(false);
    setError(null);
    router.refresh();
  }

  return (
    <form className="form card" onSubmit={submit}>
      <label>
        Name
        <input name="name" required maxLength={80} />
      </label>
      <label>
        Kind
        <select name="kind" defaultValue="checking">
          <option value="checking">Checking</option>
          <option value="savings">Savings</option>
          <option value="credit_card">Credit card</option>
        </select>
      </label>
      <label>
        Owner <span className="muted">(a label, such as Drake, Alexis or Shared)</span>
        <input name="ownerLabel" maxLength={40} />
      </label>
      <label>
        Cushion <span className="muted">(warn when the forecast goes below this; optional)</span>
        <input name="cushion" inputMode="decimal" />
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving}>
          Add account
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
