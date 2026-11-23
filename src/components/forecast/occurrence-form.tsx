"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { editEffect, type EditFields, type Effect } from "@/features/forecast/effect";
import type { ForecastInput } from "@/features/forecast/engine";
import type { OccurrenceStatus } from "@/features/forecast/occurrences";
import { formatIsoDate } from "@/features/rules/summary";
import { MAX_MOVE_DAYS } from "@/features/rules/versions";
import { addDays, parseIsoDate } from "@/lib/calendar-date";
import { toCents } from "@/lib/cents";
import { parseMoney } from "@/lib/money";
import { postJson } from "../post-json";
import { money } from "./money";

export type CurrentEdit = { status: OccurrenceStatus; confirmedAmount: string | null; movedTo: string | null; note: string | null };

const STATUSES: { value: OccurrenceStatus; label: string; hint: string }[] = [
  { value: "PLANNED", label: "Planned", hint: "expected; nothing confirmed yet" },
  { value: "CONFIRMED", label: "Confirmed", hint: "the amount is known" },
  { value: "PAID", label: "Paid", hint: "the money has moved; still counted after your last balance" },
  { value: "SKIPPED", label: "Skipped", hint: "it won't happen this time" },
];

function useSave(url: string, back: string) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function send(body: unknown) {
    setSaving(true);
    const result = await postJson(url, body);
    setSaving(false);
    if (!result.ok) return setError(result.message);
    router.push(back);
    router.refresh();
  }
  return { error, setError, saving, send };
}

/** Reset to rule on its own, for an edit whose date the rule no longer produces. */
export function ResetEditButton({ ruleId, scheduledOn, back }: { ruleId: string; scheduledOn: string; back: string }) {
  const reset = useSave(`/api/rules/${ruleId}/occurrences/${scheduledOn}/reset`, back);
  return (
    <>
      <button type="button" disabled={reset.saving} onClick={() => reset.send({})}>
        Reset to rule
      </button>
      {reset.error && (
        <p role="alert" className="form-error">
          {reset.error}
        </p>
      )}
    </>
  );
}

function EffectList({ effects }: { effects: Effect[] | null }) {
  if (effects === null) return <p className="muted">Fix the fields above to see the effect.</p>;
  if (effects.length === 0) return <p className="muted">This doesn&apos;t move money in a forecast account.</p>;
  return (
    <ul>
      {effects.map((e) => {
        const before = `${money(e.before.cents)} on ${formatIsoDate(e.before.date)}`;
        const after = `${money(e.after.cents)} on ${formatIsoDate(e.after.date)}`;
        return (
          <li key={e.accountId}>
            {e.accountName}: {before === after ? `no change, lowest ${before}` : `lowest ${before} → ${after}`}
          </li>
        );
      })}
    </ul>
  );
}

export function OccurrenceForm({
  ruleId,
  scheduledOn,
  estimate,
  current,
  input,
  back,
}: {
  ruleId: string;
  scheduledOn: string;
  /** The rule's amount for this date, used while no amount is confirmed. */
  estimate: string;
  current: CurrentEdit | null;
  input: ForecastInput;
  back: string;
}) {
  const [status, setStatus] = useState<OccurrenceStatus>(current?.status ?? "PLANNED");
  const [amount, setAmount] = useState(current?.confirmedAmount ?? "");
  const [movedTo, setMovedTo] = useState(current?.movedTo ?? "");
  const [note, setNote] = useState(current?.note ?? "");
  const save = useSave(`/api/rules/${ruleId}/occurrences/${scheduledOn}`, back);
  const reset = useSave(`/api/rules/${ruleId}/occurrences/${scheduledOn}/reset`, back);

  const skipped = status === "SKIPPED";
  const typed = skipped ? "" : amount.trim();
  const parsed = typed === "" ? null : parseMoney(typed, { allowNegative: false });
  const amountOk = typed === "" || (parsed !== null && parsed !== "0");
  const move = skipped ? "" : movedTo;
  const moveOk = move === "" || parseIsoDate(move) !== null;
  const fields: EditFields | null = amountOk && moveOk ? { status, confirmedAmount: parsed, movedTo: move === "" ? null : move } : null;
  const effects = fields ? editEffect(input, ruleId, scheduledOn, fields) : null;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fields) return save.setError(amountOk ? "Enter a date to move it to, or leave it blank." : "Enter the amount with at most two decimal places.");
    if (status === "CONFIRMED" && fields.confirmedAmount === null) return save.setError("Enter the confirmed amount, or choose another status.");
    void save.send({ ...fields, note });
  }

  const error = save.error ?? reset.error;
  const saving = save.saving || reset.saving;
  return (
    <form className="form" onSubmit={submit}>
      <fieldset>
        <legend>Status</legend>
        {STATUSES.map((s) => (
          <label key={s.value} className="checkbox">
            <input type="radio" name="status" value={s.value} checked={status === s.value} onChange={() => setStatus(s.value)} />
            {s.label} <span className="muted">— {s.hint}</span>
          </label>
        ))}
      </fieldset>
      <label>
        Confirmed amount <span className="muted">(blank uses the estimate, {money(toCents(estimate))})</span>
        <input
          inputMode="decimal"
          value={skipped ? "" : amount}
          disabled={skipped}
          onChange={(e) => {
            setAmount(e.target.value);
            if (status === "PLANNED" && e.target.value.trim() !== "") setStatus("CONFIRMED");
          }}
        />
      </label>
      <label>
        Move this one to <span className="muted">(blank keeps {formatIsoDate(scheduledOn)})</span>
        <input
          type="date"
          value={skipped ? "" : movedTo}
          disabled={skipped}
          min={addDays(scheduledOn, -MAX_MOVE_DAYS)}
          max={addDays(scheduledOn, MAX_MOVE_DAYS)}
          onChange={(e) => setMovedTo(e.target.value)}
        />
      </label>
      <label>
        Note <span className="muted">(optional)</span>
        <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </label>
      <section aria-label="Effect on the forecast">
        <h2>Effect on the lowest point</h2>
        <EffectList effects={effects} />
      </section>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving}>
          Save
        </button>
        {current && (
          <button type="button" disabled={saving} onClick={() => reset.send({})}>
            Reset to rule
          </button>
        )}
        <Link href={back}>Cancel</Link>
      </div>
    </form>
  );
}
