import Link from "next/link";
import { UPCOMING_DAYS, type UpcomingItem } from "@/features/forecast/attention";
import type { OccurrenceStatus } from "@/features/forecast/occurrences";
import { formatIsoDate } from "@/features/rules/summary";
import { signedMoney } from "./money";

const STATUS: Record<OccurrenceStatus, string> = { PLANNED: "Planned", CONFIRMED: "Confirmed", PAID: "Paid", SKIPPED: "Skipped" };

export function NextDays({ items }: { items: UpcomingItem[] }) {
  if (items.length === 0) return <p className="muted">Nothing in the next {UPCOMING_DAYS} days.</p>;
  return (
    <table className="table" aria-label={`Next ${UPCOMING_DAYS} days`}>
      <thead>
        <tr>
          <th>Date</th>
          <th>Name</th>
          <th>Accounts</th>
          <th className="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {items.map(({ occurrence: o, shares }) => (
          <tr key={`${o.ruleId}-${o.scheduledOn}`}>
            <td>{formatIsoDate(o.date)}</td>
            <td>
              <Link href={`/bills/${o.ruleId}`}>{o.ruleName}</Link>
              {o.status !== "PLANNED" && <span className="chip chip-muted">{STATUS[o.status]}</span>}
            </td>
            <td>{shares.map((s) => `${s.account.name} ${signedMoney(s.cents)}`).join(" · ")}</td>
            <td className={o.estimate ? "num estimate" : "num"} title={o.estimate ? "Estimate" : undefined}>
              {signedMoney(o.kind === "INCOME" ? o.amount : -o.amount)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
