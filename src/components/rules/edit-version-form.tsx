"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  allocationBodies,
  allocationDraftsFrom,
  scheduleBody,
  scheduleDraftFrom,
  type AccountChoice,
} from "@/features/rules/form-drafts";
import type { RuleKind, StoredVersion } from "@/features/rules/versions";
import { postJson } from "../post-json";
import { AllocationFields } from "./allocation-fields";
import { ScheduleFields } from "./schedule-fields";

type Props = { ruleId: string; kind: RuleKind; version: StoredVersion; isLatest: boolean; accounts: AccountChoice[] };

/** Edit this version: fixes a mistake in place, without making history. */
export function EditVersionForm({ ruleId, kind, version, isLatest, accounts }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(version.amount);
  const [schedule, setSchedule] = useState(() => scheduleDraftFrom(version));
  const [allocations, setAllocations] = useState(() => allocationDraftsFrom(version.allocations));
  const [note, setNote] = useState(version.note ?? "");
  const [endsOn, setEndsOn] = useState(version.effectiveTo ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Start from the saved version each time the form opens.
  function openForm() {
    setAmount(version.amount);
    setSchedule(scheduleDraftFrom(version));
    setAllocations(allocationDraftsFrom(version.allocations));
    setNote(version.note ?? "");
    setEndsOn(version.effectiveTo ?? "");
    setError(null);
    setOpen(true);
  }

  if (!open) {
    return (
      <button type="button" onClick={openForm}>
        Edit this version
      </button>
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = scheduleBody(schedule);
    if (!body) return setError("Finish the schedule first.");
    setSaving(true);
    const result = await postJson(`/api/rules/${ruleId}/versions/${version.id}/update`, {
      amount,
      schedule: body,
      allocations: allocationBodies(allocations),
      note,
      ...(isLatest ? { effectiveTo: endsOn === "" ? null : endsOn } : {}),
    });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    setOpen(false);
    router.refresh();
  }

  return (
    <form className="form" onSubmit={submit}>
      <p className="muted">This fixes the version itself. To change things from a date on, use Change from… instead.</p>
      <label>
        Amount
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </label>
      <ScheduleFields value={schedule} onChange={setSchedule} />
      <AllocationFields kind={kind} accounts={accounts} value={allocations} onChange={setAllocations} />
      {isLatest && (
        <label>
          Ends on <span className="muted">(blank means no end)</span>
          <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </label>
      )}
      <label>
        Note
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving}>
          Save version
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
