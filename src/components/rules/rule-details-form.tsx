"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AccountChoice } from "@/features/rules/form-drafts";
import type { RuleKind } from "@/features/rules/versions";
import { postJson } from "../post-json";

type Props = {
  ruleId: string;
  kind: RuleKind;
  name: string;
  category: string | null;
  notes: string | null;
  paysAccountId: string | null;
  paysAccountName: string | null;
  cards: AccountChoice[];
};

/** Name, category, notes and (for a card payment) the card it pays. None of these make history. */
export function RuleDetailsForm({ ruleId, kind, name, category, notes, paysAccountId, paysAccountName, cards }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Edit details
      </button>
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSaving(true);
    const result = await postJson(`/api/rules/${ruleId}/update`, {
      name: String(data.get("name") ?? ""),
      category: String(data.get("category") ?? ""),
      notes: String(data.get("notes") ?? ""),
      ...(kind === "BILL" ? { paysAccountId: String(data.get("paysAccountId") ?? "") || null } : {}),
    });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    setOpen(false);
    router.refresh();
  }

  return (
    <form className="form card" onSubmit={submit}>
      <label>
        Name
        <input name="name" defaultValue={name} required maxLength={80} />
      </label>
      <label>
        Category
        <input name="category" defaultValue={category ?? ""} maxLength={40} />
      </label>
      <label>
        Notes
        <input name="notes" defaultValue={notes ?? ""} maxLength={500} />
      </label>
      {kind === "BILL" && (
        <label>
          Pays card
          <select name="paysAccountId" defaultValue={paysAccountId ?? ""}>
            <option value="">None</option>
            {paysAccountId !== null && !cards.some((card) => card.id === paysAccountId) && (
              <option value={paysAccountId}>{paysAccountName ?? "Unknown account"} (archived)</option>
            )}
            {cards.map((card) => (
              <option key={card.id} value={card.id}>
                {card.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving}>
          Save details
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
