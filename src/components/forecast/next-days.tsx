import Link from "next/link";
import { UPCOMING_DAYS, type UpcomingItem } from "@/features/forecast/attention";
import { formatIsoDate } from "@/features/rules/summary";
import { signedMoney } from "./money";
import { occurrenceHref } from "./occurrence-link";
import { StatusChip } from "./status";

export function NextDays({ items }: { items: UpcomingItem[] }) {
  if (items.length === 0) return <p className="muted">Nothing in the next {UPCOMING_DAYS} days.</p>;
  return (
    <table className="table stack" aria-label={`Next ${UPCOMING_DAYS} days`}>
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
            <td className="c-sub">{formatIsoDate(o.date)}</td>
            <td className="c-main">
              <Link href={occurrenceHref(o.ruleId, o.scheduledOn, "/")}>{o.ruleName}</Link>
              <StatusChip status={o.status} />
            </td>
            <td className="c-sub2">{shares.map((s) => `${s.account.name} ${signedMoney(s.cents)}`).join(" · ")}</td>
            <td
              className={["num c-amt", o.estimate && "estimate", o.kind === "INCOME" && "money-in"].filter(Boolean).join(" ")}
              title={o.estimate ? "Estimate" : undefined}
            >
              {signedMoney(o.kind === "INCOME" ? o.amount : -o.amount)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
