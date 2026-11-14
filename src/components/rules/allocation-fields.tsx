"use client";

import type { AccountChoice, AllocationDraft } from "@/features/rules/form-drafts";
import type { AllocationMode } from "@/features/rules/splits";
import type { RuleKind } from "@/features/rules/versions";

const MAX_ROWS = 5;

/** Where the money goes (income, split across accounts) or comes from (a bill: one account). */
export function AllocationFields({
  kind,
  accounts,
  value,
  onChange,
}: {
  kind: RuleKind;
  accounts: AccountChoice[];
  value: AllocationDraft[];
  onChange: (next: AllocationDraft[]) => void;
}) {
  if (kind === "BILL") {
    const accountId = value[0]?.accountId ?? "";
    return (
      <label>
        Paid from <span className="muted">(a card here means the card payment covers it)</span>
        <select value={accountId} onChange={(e) => onChange([{ accountId: e.target.value, mode: "REMAINDER", value: "" }])} required>
          <option value="">Choose an account</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const usable = accounts.filter((account) => account.type !== "credit");
  const setRow = (index: number, patch: Partial<AllocationDraft>) =>
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <fieldset>
      <legend>Goes to</legend>
      {value.map((row, index) => (
        <div className="inline-form" key={index}>
          <label>
            Account {index + 1}
            <select value={row.accountId} onChange={(e) => setRow(index, { accountId: e.target.value })} required>
              <option value="">Choose an account</option>
              {usable.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Share {index + 1}
            <select value={row.mode} onChange={(e) => setRow(index, { mode: e.target.value as AllocationMode })}>
              <option value="PERCENT">Percent</option>
              <option value="FIXED">Fixed amount</option>
              <option value="REMAINDER">The rest</option>
            </select>
          </label>
          {row.mode !== "REMAINDER" && (
            <label>
              Value {index + 1}
              <input inputMode="decimal" value={row.value} onChange={(e) => setRow(index, { value: e.target.value })} required />
            </label>
          )}
          {value.length > 1 && (
            <button
              type="button"
              aria-label={`Remove account ${index + 1}`}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      {value.length < MAX_ROWS && (
        <button type="button" onClick={() => onChange([...value, { accountId: "", mode: "PERCENT", value: "" }])}>
          Add an account
        </button>
      )}
      <p className="muted">Exactly one account takes the rest.</p>
    </fieldset>
  );
}
