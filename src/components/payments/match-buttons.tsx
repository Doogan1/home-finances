"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "../post-json";

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function run(url: string, body: unknown, then?: () => void) {
    setSaving(true);
    setError(null);
    const result = await postJson(url, body);
    setSaving(false);
    if (!result.ok) return setError(result.message);
    then?.();
    router.refresh();
  }
  return { run, error, saving };
}

const Problem = ({ error }: { error: string | null }) =>
  error ? (
    <span role="alert" className="form-error">
      {error}
    </span>
  ) : null;

/** Yes links the transaction to the bill; No means it is never proposed for that bill again. */
export function MatchButtons({ transactionId, ruleId, scheduledOn }: { transactionId: string; ruleId: string; scheduledOn: string | null }) {
  const { run, error, saving } = useAction();
  return (
    <span className="actions">
      <button type="button" disabled={saving} onClick={() => run(`/api/transactions/${transactionId}/match`, { ruleId, scheduledOn })}>
        Yes
      </button>
      <button type="button" disabled={saving} onClick={() => run(`/api/transactions/${transactionId}/decline`, { ruleId })}>
        No
      </button>
      <Link href={`/transactions/${transactionId}`}>Choose another bill</Link>
      <Problem error={error} />
    </span>
  );
}

export function UndoMatchButton({ transactionId, label = "Undo match" }: { transactionId: string; label?: string }) {
  const { run, error, saving } = useAction();
  return (
    <>
      <button type="button" disabled={saving} onClick={() => run(`/api/transactions/${transactionId}/unmatch`, {})}>
        {label}
      </button>
      <Problem error={error} />
    </>
  );
}

export type MatchChoice = { ruleId: string; name: string; dates: { scheduledOn: string; label: string }[] };

/** Pick the bill (or income) a transaction belongs to, and which of its due dates it paid. */
export function ChooseMatchForm({
  transactionId,
  choices,
  suggested,
}: {
  transactionId: string;
  choices: MatchChoice[];
  suggested: { ruleId: string; scheduledOn: string | null } | null;
}) {
  const { run, error, saving } = useAction();
  const first = choices.find((c) => c.ruleId === suggested?.ruleId) ?? choices[0];
  const [ruleId, setRuleId] = useState(first.ruleId);
  const [scheduledOn, setScheduledOn] = useState(suggested?.ruleId === first.ruleId ? (suggested.scheduledOn ?? "") : (first.dates[0]?.scheduledOn ?? ""));
  const choice = choices.find((c) => c.ruleId === ruleId) ?? first;

  return (
    <form
      className="form card"
      onSubmit={(event) => {
        event.preventDefault();
        void run(`/api/transactions/${transactionId}/match`, { ruleId, scheduledOn: scheduledOn === "" ? null : scheduledOn });
      }}
    >
      <label>
        Bill or income
        <select
          value={ruleId}
          onChange={(event) => {
            const next = choices.find((c) => c.ruleId === event.target.value) ?? first;
            setRuleId(next.ruleId);
            setScheduledOn(next.dates[0]?.scheduledOn ?? "");
          }}
        >
          {choices.map((c) => (
            <option key={c.ruleId} value={c.ruleId}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Which due date
        <select value={scheduledOn} onChange={(event) => setScheduledOn(event.target.value)}>
          {choice.dates.map((date) => (
            <option key={date.scheduledOn} value={date.scheduledOn}>
              {date.label}
            </option>
          ))}
          <option value="">No due date (keep as history)</option>
        </select>
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving}>
          Match
        </button>
      </div>
    </form>
  );
}
