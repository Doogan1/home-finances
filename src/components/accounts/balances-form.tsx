"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseMoney } from "@/lib/money";
import { postJson } from "../post-json";

export type BalanceRow = {
  id: string;
  name: string;
  ownerLabel: string | null;
  owedLabel: boolean;
  /** Plaid-linked: shown read-only, never submitted. */
  synced: boolean;
  last: { amount: string; asOf: string } | null;
};

/** One "as of" date, one field per account; a blank field means "no change". */
export function BalancesForm({ rows, today }: { rows: BalanceRow[]; today: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const entries: { accountId: string; balance: string }[] = [];
    for (const row of rows) {
      if (row.synced) continue;
      const typed = String(data.get(row.id) ?? "").trim();
      if (typed === "") continue;
      // Checked here only to name the field; the server checks again.
      if (parseMoney(typed, { allowNegative: true }) === null) {
        return setError(`"${typed}" for ${row.name} is not an amount (use at most two decimal places).`);
      }
      entries.push({ accountId: row.id, balance: typed });
    }
    if (entries.length === 0) return setError("Enter at least one balance.");

    setSaving(true);
    const result = await postJson("/api/balances", {
      asOfDate: String(data.get("asOfDate") ?? ""),
      note: String(data.get("note") ?? ""),
      entries,
    });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    router.push("/accounts");
    router.refresh();
  }

  return (
    <form className="form" onSubmit={submit}>
      <label>
        As of <span className="muted">(the balance at the end of this day)</span>
        <input type="date" name="asOfDate" defaultValue={today} max={today} required />
      </label>
      <table className="table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Owner</th>
            <th className="num">Last balance</th>
            <th>New balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                {row.name}
                {row.owedLabel && <span className="muted"> (owed)</span>}
              </td>
              <td>{row.ownerLabel ?? ""}</td>
              <td className="num">{row.last ? `${row.last.amount} · ${row.last.asOf}` : "none yet"}</td>
              <td>
                {row.synced ? (
                  <span className="muted">Synced from the bank</span>
                ) : (
                  <input name={row.id} inputMode="decimal" aria-label={`New balance for ${row.name}`} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label>
        Note <span className="muted">(optional)</span>
        <input name="note" maxLength={200} />
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button type="submit" disabled={saving}>
        Save balances
      </button>
    </form>
  );
}
