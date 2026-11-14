"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { formatMoney } from "@/features/plaid/format";
import {
  allocationBodies,
  allocationDraftsFrom,
  allocationsForPreview,
  amountForPreview,
  patternFromDraft,
  scheduleBody,
  scheduleDraftFrom,
  type AccountChoice,
} from "@/features/rules/form-drafts";
import { RULE_MESSAGES } from "@/features/rules/messages";
import { formatIsoDate, latestVersion } from "@/features/rules/summary";
import { previewChange, type ChangePreview, type Planned, type RuleKind, type StoredVersion } from "@/features/rules/versions";
import { fromCents } from "@/lib/cents";
import { postJson } from "../post-json";
import { AllocationFields } from "./allocation-fields";
import { ScheduleFields } from "./schedule-fields";

type Props = {
  ruleId: string;
  kind: RuleKind;
  versions: StoredVersion[];
  accounts: AccountChoice[];
  names: Record<string, string>;
  today: string;
};

/** Change from a date: shows what would happen before anything is saved. */
export function ChangeFromForm({ ruleId, kind, versions, accounts, names, today }: Props) {
  const router = useRouter();
  const current = latestVersion(versions);
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(today);
  const [amount, setAmount] = useState(current.amount);
  const [allocations, setAllocations] = useState(() => allocationDraftsFrom(current.allocations));
  const [note, setNote] = useState("");
  const [changeSchedule, setChangeSchedule] = useState(false);
  const [schedule, setSchedule] = useState(() => scheduleDraftFrom(current));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const preview = useMemo(() => {
    const previewAmount = amountForPreview(amount);
    const previewAllocations = allocationsForPreview(allocations);
    const pattern = changeSchedule ? patternFromDraft(schedule) : null;
    if (!from || !previewAmount || !previewAllocations || (changeSchedule && !pattern)) return null;
    return previewChange(versions, { from, amount: previewAmount, note: null, allocations: previewAllocations, schedule: pattern });
  }, [from, amount, allocations, changeSchedule, schedule, versions]);

  // Start from the latest version each time the form opens, not from an earlier visit.
  function openForm() {
    setFrom(today);
    setAmount(current.amount);
    setAllocations(allocationDraftsFrom(current.allocations));
    setNote("");
    setChangeSchedule(false);
    setSchedule(scheduleDraftFrom(current));
    setError(null);
    setOpen(true);
  }

  if (!open) {
    return (
      <button type="button" onClick={openForm}>
        Change from…
      </button>
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = changeSchedule ? scheduleBody(schedule) : null;
    if (changeSchedule && !body) return setError("Finish the new schedule first.");
    setSaving(true);
    const result = await postJson(`/api/rules/${ruleId}/change`, {
      from,
      amount,
      allocations: allocationBodies(allocations),
      note,
      ...(body ? { schedule: body } : {}),
    });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    setOpen(false);
    router.refresh();
  }

  return (
    <form className="form card" onSubmit={submit}>
      <h3>Change from…</h3>
      <label>
        Starting
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
      </label>
      <label>
        Amount
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </label>
      <AllocationFields kind={kind} accounts={accounts} value={allocations} onChange={setAllocations} />
      <label className="checkbox">
        <input type="checkbox" checked={changeSchedule} onChange={(e) => setChangeSchedule(e.target.checked)} /> Change the schedule too
      </label>
      {changeSchedule && <ScheduleFields value={schedule} onChange={setSchedule} />}
      <label>
        Note <span className="muted">(optional, such as &quot;401(k) starts&quot;)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      </label>
      <PreviewText preview={preview} names={names} />
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving}>
          Save change
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function PreviewText({ preview, names }: { preview: Planned<ChangePreview> | null; names: Record<string, string> }) {
  if (!preview) return <p className="muted">Preview: fill in the date, the amount and the accounts.</p>;
  if (!preview.ok) return <p className="muted">Preview: {RULE_MESSAGES[preview.code]}</p>;
  const { endOn, next, perAccount } = preview.value;
  const upcoming = next.map((o) => `${formatIsoDate(o.date)} ${formatMoney(o.amount, "USD")}`).join(" · ");
  return (
    <div className="muted">
      <p>
        Preview: the current version ends {formatIsoDate(endOn)}.{" "}
        {next.length > 0 ? `Next: ${upcoming}.` : "The new version produces no dates."}
      </p>
      {perAccount.map(({ accountId, change }) => (
        <p key={accountId}>
          {names[accountId] ?? "An account"} gets {formatMoney(fromCents(change < 0n ? -change : change), "USD")}{" "}
          {change < 0n ? "less" : "more"} each time.
        </p>
      ))}
    </div>
  );
}
