import Link from "next/link";
import { ESTIMATE_DAYS, attentionCount, type Attention, type LowBalance } from "@/features/forecast/attention";
import type { MatchQuestion } from "@/features/payments/queries";
import { formatIsoDate } from "@/features/rules/summary";
import { MatchQuestionItem, matchKey } from "../payments/match-question";
import { ClearQuestionItem, clearKey } from "./did-it-clear";
import { money } from "./money";
import { occurrenceHref } from "./occurrence-link";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describeLow(low: LowBalance): string {
  const parts: string[] = [];
  if (low.firstBelowCushion) parts.push(`below its cushion on ${formatIsoDate(low.firstBelowCushion)} (${plural(low.daysBelowCushion, "day")})`);
  if (low.firstBelowZero) parts.push(`below zero on ${formatIsoDate(low.firstBelowZero)} (${plural(low.daysBelowZero, "day")})`);
  return `${low.account.name} goes ${parts.join(" and ")}; lowest ${money(low.lowest.cents)} on ${formatIsoDate(low.lowest.date)}.`;
}

/** Home asks about this many payments; the rest wait on Transactions. */
const QUESTIONS_SHOWN = 5;

export type PaymentsDiffer = { ruleId: string; ruleName: string; planned: string; typical: string; count: number };

export function NeedsAttention({
  attention,
  questions = [],
  differ = [],
}: {
  attention: Attention;
  questions?: readonly MatchQuestion[];
  differ?: readonly PaymentsDiffer[];
}) {
  if (attentionCount(attention) + questions.length + differ.length === 0) return <p className="muted">Nothing needs attention.</p>;
  return (
    <ul className="attention">
      {questions.slice(0, QUESTIONS_SHOWN).map((q) => (
        <MatchQuestionItem key={matchKey(q)} question={q} />
      ))}
      {questions.length > QUESTIONS_SHOWN && (
        <li key="more-questions">
          <Link href="/transactions">
            {questions.length - QUESTIONS_SHOWN} more {questions.length - QUESTIONS_SHOWN === 1 ? "payment" : "payments"} to confirm
          </Link>
        </li>
      )}
      {attention.needsBalance.map((account) => (
        <li key={`balance-${account.id}`}>
          {account.name} needs a balance before it can be forecast. <Link href="/accounts/balances">Update balances</Link>
        </li>
      ))}
      {attention.stale.map((stale) => (
        <li key={`stale-${stale.account.id}`}>
          {stale.account.name}&apos;s balance is from {formatIsoDate(stale.date)}, {plural(stale.days, "day")} ago.{" "}
          <Link href="/accounts/balances">Update balances</Link>
        </li>
      ))}
      {attention.low.map((low) => (
        <li key={`low-${low.account.id}`} className={low.firstBelowZero ? "attention-low attention-negative" : "attention-low"}>
          {describeLow(low)}
        </li>
      ))}
      {attention.estimates.length > 0 && (
        <li key="estimates">
          Estimates due in the next {ESTIMATE_DAYS} days:
          <ul>
            {attention.estimates.map((o) => (
              <li key={`${o.ruleId}-${o.scheduledOn}`}>
                {formatIsoDate(o.date)} <Link href={occurrenceHref(o.ruleId, o.scheduledOn, "/")}>{o.ruleName}</Link>{" "}
                <span className="estimate">{money(o.amount)}</span>
              </li>
            ))}
          </ul>
        </li>
      )}
      {attention.didItClear.map((q) => (
        <ClearQuestionItem key={clearKey(q)} question={q} back="/" />
      ))}
      {differ.map((d) => (
        <li key={`differ-${d.ruleId}`}>
          <Link href={`/bills/${d.ruleId}`}>{d.ruleName}</Link> is planned at {d.planned}, but its last {d.count} payments were typically{" "}
          {d.typical}. Change its amount, or set it to vary.
        </li>
      ))}
      {attention.orphanEdits.map((e) => (
        <li key={`orphan-${e.ruleId}-${e.scheduledOn}`}>
          <Link href={`/bills/${e.ruleId}`}>{e.ruleName}</Link> has an edit for {formatIsoDate(e.scheduledOn)}, a date it no longer
          produces. <Link href={occurrenceHref(e.ruleId, e.scheduledOn, "/")}>Review it</Link>
        </li>
      ))}
    </ul>
  );
}
