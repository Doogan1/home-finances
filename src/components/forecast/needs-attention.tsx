import Link from "next/link";
import { ESTIMATE_DAYS, attentionCount, type Attention, type LowBalance } from "@/features/forecast/attention";
import { formatIsoDate } from "@/features/rules/summary";
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

export function NeedsAttention({ attention }: { attention: Attention }) {
  if (attentionCount(attention) === 0) return <p className="muted">Nothing needs attention.</p>;
  return (
    <ul className="attention">
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
        <li key={`low-${low.account.id}`}>{describeLow(low)}</li>
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
      {attention.orphanEdits.map((e) => (
        <li key={`orphan-${e.ruleId}-${e.scheduledOn}`}>
          <Link href={`/bills/${e.ruleId}`}>{e.ruleName}</Link> has an edit for {formatIsoDate(e.scheduledOn)}, a date it no longer
          produces. <Link href={occurrenceHref(e.ruleId, e.scheduledOn, "/")}>Review it</Link>
        </li>
      ))}
    </ul>
  );
}
