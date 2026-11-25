import Link from "next/link";
import type { MatchQuestion } from "@/features/payments/queries";
import { formatIsoDate } from "@/features/rules/summary";
import { money } from "../forecast/money";
import { MatchButtons } from "./match-buttons";

export const matchKey = (q: MatchQuestion) => `match-${q.transactionId}`;

/** "Is this Electric?": one bank transaction the matcher thinks paid a bill, for the person to confirm. */
export function MatchQuestionItem({ question: q }: { question: MatchQuestion }) {
  return (
    <li>
      Is this <Link href={`/bills/${q.ruleId}`}>{q.ruleName}</Link>
      {q.scheduledOn ? `, due ${formatIsoDate(q.scheduledOn)}` : " (from before its first date)"}?{" "}
      <Link href={`/transactions/${q.transactionId}`}>{q.payee}</Link>, {money(q.cents)} {q.kind === "BILL" ? "out of" : "into"} {q.accountName} on{" "}
      {formatIsoDate(q.date)}. <MatchButtons transactionId={q.transactionId} ruleId={q.ruleId} scheduledOn={q.scheduledOn} />
    </li>
  );
}
