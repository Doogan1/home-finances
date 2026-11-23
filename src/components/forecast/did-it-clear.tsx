import Link from "next/link";
import type { ClearQuestion } from "@/features/forecast/attention";
import { formatIsoDate } from "@/features/rules/summary";
import { ClearButtons } from "./clear-buttons";
import { signedMoney } from "./money";
import { occurrenceHref } from "./occurrence-link";

export const clearKey = (q: ClearQuestion) => `clear-${q.occurrence.ruleId}-${q.occurrence.scheduledOn}-${q.account.id}`;

export function ClearQuestionItem({ question: q, back }: { question: ClearQuestion; back: string }) {
  return (
    <li>
      Did it clear? <Link href={occurrenceHref(q.occurrence.ruleId, q.occurrence.scheduledOn, back)}>{q.occurrence.ruleName}</Link>,{" "}
      {signedMoney(q.cents)} in {q.account.name} on {formatIsoDate(q.occurrence.date)}, on or before its balance of{" "}
      {formatIsoDate(q.snapshotDate)}. <ClearButtons ruleId={q.occurrence.ruleId} scheduledOn={q.occurrence.scheduledOn} accountId={q.account.id} />
    </li>
  );
}
