"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "./post-json";

type Target = { id: string; name: string };

/**
 * "Use for…" on one account from a connected bank: pick the hand-entered account
 * it really is, read what will move, then attach. Nothing is sent until the
 * person confirms.
 */
export function AttachAccount({
  bankAccount,
  institutionName,
  targets,
}: {
  bankAccount: { id: string; label: string };
  institutionName: string;
  targets: Target[];
}) {
  const router = useRouter();
  const [targetId, setTargetId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((t) => t.id === targetId) ?? null;

  async function attach() {
    if (!target) return;
    setWorking(true);
    setError(null);
    const result = await postJson<unknown>(`/api/accounts/${target.id}/attach`, { plaidAccountId: bankAccount.id });
    setWorking(false);
    if (!result.ok) return setError(result.message);
    setConfirming(false);
    router.refresh();
  }

  return (
    <div>
      {confirming && target ? (
        <div className="confirm">
          <p>
            <strong>
              Attach {bankAccount.label} to {target.name}?
            </strong>{" "}
            {target.name} keeps its name, owner, cushion, bills and income, and the balances you entered. From now on its
            balances come from {institutionName}, and the balances and transactions already saved for {bankAccount.label}{" "}
            move to it. {bankAccount.label} is then no longer listed on its own.
          </p>
          <p className="muted">
            To undo it later, disconnect the bank and delete its saved history: {target.name} goes back to being entered by
            hand, without the bank&apos;s balances and transactions.
          </p>
          <button type="button" disabled={working} onClick={attach}>
            {working ? "Attaching…" : "Yes, attach"}
          </button>{" "}
          <button type="button" disabled={working} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <span className="inline-form">
          <label>
            Use for…{" "}
            <select aria-label={`Use ${bankAccount.label} for`} value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              <option value="">Choose an account entered by hand</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>{" "}
          <button
            type="button"
            disabled={!target}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            Attach…
          </button>
        </span>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
