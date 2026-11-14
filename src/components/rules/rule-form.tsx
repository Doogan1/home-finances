"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { allocationBodies, emptySchedule, scheduleBody, type AccountChoice, type AllocationDraft } from "@/features/rules/form-drafts";
import type { RuleKind } from "@/features/rules/versions";
import { postJson } from "../post-json";
import { AllocationFields } from "./allocation-fields";
import { ScheduleFields } from "./schedule-fields";

/** Adds a bill or an income stream, with its first version. */
export function RuleForm({ kind, accounts }: { kind: RuleKind; accounts: AccountChoice[] }) {
  const router = useRouter();
  const [schedule, setSchedule] = useState(() => emptySchedule(kind === "INCOME" ? "WEEKLY" : "MONTHLY"));
  const [allocations, setAllocations] = useState<AllocationDraft[]>([{ accountId: "", mode: "REMAINDER", value: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const cards = accounts.filter((account) => account.type === "credit");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = scheduleBody(schedule);
    if (!body) return setError("Finish the schedule first.");
    setSaving(true);
    const result = await postJson<{ id: string }>("/api/rules", {
      kind,
      name: String(data.get("name") ?? ""),
      category: String(data.get("category") ?? ""),
      amount: String(data.get("amount") ?? ""),
      schedule: body,
      allocations: allocationBodies(allocations),
      ...(kind === "BILL" ? { paysAccountId: String(data.get("paysAccountId") ?? "") || null } : {}),
    });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    router.push(`/bills/${result.data.id}`);
  }

  return (
    <form className="form card" onSubmit={submit}>
      <label>
        Name
        <input name="name" required maxLength={80} />
      </label>
      <label>
        Category <span className="muted">(optional, such as Housing)</span>
        <input name="category" maxLength={40} />
      </label>
      <label>
        Amount
        <input name="amount" inputMode="decimal" required />
      </label>
      <ScheduleFields value={schedule} onChange={setSchedule} />
      <AllocationFields kind={kind} accounts={accounts} value={allocations} onChange={setAllocations} />
      {kind === "BILL" && cards.length > 0 && (
        <label>
          Pays card <span className="muted">(only for a card payment, such as &quot;Amex payment&quot;)</span>
          <select name="paysAccountId" defaultValue="">
            <option value="">None</option>
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
          {kind === "INCOME" ? "Add income" : "Add bill"}
        </button>
      </div>
    </form>
  );
}
