import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { TimeZoneForm } from "@/components/accounts/time-zone-form";
import { formatMoney } from "@/features/plaid/format";
import { accountLookup, listRules, type RuleView } from "@/features/rules/queries";
import {
  describeAllocations,
  describeSchedule,
  monthlyEquivalent,
  ruleGroup,
  ruleState,
  versionFor,
  type RuleGroup,
  type RuleState,
} from "@/features/rules/summary";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { todayIn, type IsoDate } from "@/lib/calendar-date";
import { fromCents, toCents, type Cents } from "@/lib/cents";
import { getDb } from "@/lib/db";

export const metadata: Metadata = { title: "Bills & income · Home Finances" };

const FILTERS = ["active", "ended", "all"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_LABELS: Record<Filter, string> = { active: "Active", ended: "Ended", all: "All" };

const GROUPS: { group: RuleGroup; title: string; note?: string }[] = [
  { group: "income", title: "Income" },
  { group: "checking", title: "Paid from checking and savings" },
  { group: "cards", title: "On cards", note: "Shown, not counted as cash: the card payment covers them." },
];

type SearchParams = Promise<{ show?: string }>;

export default function BillsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main>
      <div className="page-head">
        <h1>Bills &amp; income</h1>
        <p className="actions">
          <Link className="button button-primary" href="/bills/new?kind=bill">
            + Add bill
          </Link>
          <Link className="button" href="/bills/new?kind=income">
            + Add income
          </Link>
        </p>
      </div>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Rules searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

const money = (cents: Cents) => formatMoney(fromCents(cents), "USD");

type Row = {
  id: string;
  name: string;
  state: RuleState;
  group: RuleGroup;
  schedule: string;
  accounts: string;
  amount: string;
  monthly: Cents | null;
};

function describeRow(rule: RuleView, today: IsoDate, accounts: Map<string, { name: string; type: string }>): Row {
  const version = versionFor(rule.versions, today);
  const named = version.allocations.map((a) => ({ ...a, accountName: accounts.get(a.accountId)?.name ?? "Unknown account" }));
  const pays = rule.paysAccount ? ` → ${rule.paysAccount.name}` : "";
  return {
    id: rule.id,
    name: rule.name,
    state: ruleState(rule, today),
    group: ruleGroup(rule.kind, version.allocations.map((a) => accounts.get(a.accountId)?.type ?? "")),
    schedule: describeSchedule(version),
    accounts: `${describeAllocations(named)}${pays}`,
    amount: formatMoney(version.amount, "USD"),
    monthly: monthlyEquivalent(toCents(version.amount), version),
  };
}

function FilterLinks({ current }: { current: Filter }) {
  return (
    <p className="pills">
      <span className="sr-only">Show:</span>
      {FILTERS.map((filter) =>
        filter === current ? (
          <strong key={filter} className="pill" aria-current="true">
            {FILTER_LABELS[filter]}
          </strong>
        ) : (
          <Link key={filter} className="pill" href={filter === "active" ? "/bills" : `/bills?show=${filter}`}>
            {FILTER_LABELS[filter]}
          </Link>
        ),
      )}
    </p>
  );
}

async function Rules({ searchParams }: { searchParams: SearchParams }) {
  const { show } = await searchParams;
  const filter: Filter = FILTERS.find((f) => f === show) ?? "active";
  const { householdId } = await requireHouseholdOrRedirect();
  const db = getDb();
  const [household, rules, accounts] = await Promise.all([
    db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } }),
    listRules(db, householdId),
    accountLookup(db, householdId),
  ]);

  if (!household.timeZone) {
    return (
      <section className="notice">
        <p>Choose your household&apos;s time zone first. It decides which bills and income have ended.</p>
        <TimeZoneForm current={null} zones={Intl.supportedValuesOf("timeZone")} />
      </section>
    );
  }
  if (rules.length === 0) {
    return <p className="muted">Nothing yet. Add your paychecks and bills to see them here.</p>;
  }

  const today = todayIn(household.timeZone);
  const rows = rules.map((rule) => describeRow(rule, today, accounts)).filter((row) => filter === "all" || row.state === filter);
  return (
    <>
      <FilterLinks current={filter} />
      {rows.length === 0 && <p className="muted">Nothing here. Try All.</p>}
      {GROUPS.map(({ group, title, note }) => {
        const inGroup = rows.filter((row) => row.group === group);
        if (inGroup.length === 0) return null;
        // Only rows still running count towards the monthly total.
        const total = inGroup.reduce((sum, row) => (row.state === "active" ? sum + (row.monthly ?? 0n) : sum), 0n);
        const allActive = inGroup.every((row) => row.state === "active");
        return (
          <section key={group} className="panel panel-flush">
            <h2>{title}</h2>
            {note && <p className="muted">{note}</p>}
            <table className="table stack" aria-label={title}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Schedule</th>
                  <th>Accounts</th>
                  <th className="num">Amount</th>
                  <th className="num">About per month</th>
                </tr>
              </thead>
              <tbody>
                {inGroup.map((row) => (
                  <tr key={row.id}>
                    <td className="c-main">
                      <Link href={`/bills/${row.id}`}>{row.name}</Link>{" "}
                      {row.state !== "active" && <span className="chip chip-muted">{row.state === "ended" ? "Ended" : "Archived"}</span>}
                    </td>
                    <td className="c-sub">{row.schedule}</td>
                    <td className="c-sub2">{row.accounts}</td>
                    <td className="num c-amt">{row.amount}</td>
                    <td className="num c-side">
                      {row.monthly === null ? "—" : money(row.monthly)}
                      {row.monthly !== null && <span className="phone-only"> a month</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>
                    About {money(total)} a month {allActive ? "in all" : "for the active ones"}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </section>
        );
      })}
    </>
  );
}
