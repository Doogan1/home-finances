import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccountPicker } from "@/components/forecast/account-picker";
import { NeedsTimeZone, NoForecastAccount } from "@/components/forecast/forecast-notices";
import { money, signedMoney } from "@/components/forecast/money";
import { occurrenceHref } from "@/components/forecast/occurrence-link";
import { StatusChip } from "@/components/forecast/status";
import { tintClass, tintText } from "@/components/forecast/tint";
import { chooseSeries, loadHouseholdForecast, loadPast } from "@/features/forecast/page-data";
import { pastRows } from "@/features/forecast/past";
import { registerRows } from "@/features/forecast/register";
import { formatIsoDate } from "@/features/rules/summary";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { toCents } from "@/lib/cents";

export const metadata: Metadata = { title: "Register · Home Finances" };

type SearchParams = Promise<{ account?: string; past?: string }>;

/** How far back the Register can show, a step at a time. */
const PAST_STEPS = [30, 90, 180, 365];

export default function RegisterPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main>
      <h1>Register</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Register searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Register({ searchParams }: { searchParams: SearchParams }) {
  const { householdId } = await requireHouseholdOrRedirect();
  const { account, past: requested } = await searchParams;
  const data = await loadHouseholdForecast(householdId);
  if (!data.ready) return <NeedsTimeZone />;
  const selected = chooseSeries(data.charted, account);
  if (!selected) return <NoForecastAccount />;

  const here = `/register?account=${selected.account.id}`;
  const days = PAST_STEPS.find((step) => String(step) === requested) ?? null;
  const back = days === null ? here : `${here}&past=${days}`;
  const rows = registerRows(selected);
  const pastDays = days === null ? [] : await loadPast(householdId, data, selected, days);
  const earlier = pastRows(pastDays);
  const saved = pastDays.filter((day) => day.from === "saved");
  const further = days === null ? PAST_STEPS[0] : (PAST_STEPS[PAST_STEPS.indexOf(days) + 1] ?? null);
  return (
    <>
      <AccountPicker
        charted={data.charted}
        selected={selected}
        hrefFor={(id) => (days === null ? `/register?account=${id}` : `/register?account=${id}&past=${days}`)}
      />
      <p className="pills">
        {further !== null && (
          <Link className="pill" href={`${here}&past=${further}#latest`}>
            {days === null ? `Show the past ${further} days` : `Show earlier (${further} days)`}
          </Link>
        )}
        {days !== null && (
          <Link className="pill" href={here}>
            Hide the past
          </Link>
        )}
      </p>
      <div className="panel panel-flush">
        <table className="table stack" aria-label={`${selected.account.name} register`}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Name</th>
              <th className="num">Amount</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {earlier.length === 0 &&
              saved.map((day) => (
                <tr key={`saved-${day.date}`} className="past-row">
                  <td className="c-sub">{formatIsoDate(day.date)}</td>
                  <td className="c-main">Balance saved</td>
                  <td />
                  <td className="num c-side strong">{money(day.closing)}</td>
                </tr>
              ))}
            {earlier.map((row) => (
              <tr key={row.transaction.id} className="past-row">
                <td className="c-sub">{formatIsoDate(row.date)}</td>
                <td className="c-main">
                  <Link href={`/transactions/${row.transaction.id}`}>{row.transaction.payee}</Link>
                  {row.transaction.ruleId && (
                    <>
                      {" "}
                      <Link className="chip chip-ok" href={`/bills/${row.transaction.ruleId}`}>
                        {row.transaction.ruleName}
                      </Link>
                    </>
                  )}
                </td>
                <td className={row.transaction.cents > 0n ? "num c-amt money-in" : "num c-amt"}>{signedMoney(row.transaction.cents)}</td>
                <td className="num c-side strong">{money(row.balance)}</td>
              </tr>
            ))}
            <tr id="latest">
              <td className="c-sub">{formatIsoDate(selected.snapshot.date)}</td>
              <td className="c-main">Balance</td>
              <td />
              <td className="num c-side strong">{money(toCents(selected.snapshot.balance))}</td>
            </tr>
            {rows.map((row) => (
              <tr key={`${row.occurrence.ruleId}-${row.occurrence.scheduledOn}`} className={tintClass(row)}>
                <td className="c-sub">{formatIsoDate(row.date)}</td>
                <td className="c-main">
                  <Link href={occurrenceHref(row.occurrence.ruleId, row.occurrence.scheduledOn, back)}>{row.occurrence.ruleName}</Link>
                  <StatusChip status={row.occurrence.status} />
                </td>
                <td
                  className={["num c-amt", row.occurrence.estimate && "estimate", row.cents > 0n && "money-in"].filter(Boolean).join(" ")}
                  title={row.occurrence.estimate ? "Estimate" : undefined}
                >
                  {signedMoney(row.cents)}
                </td>
                <td className="num c-side strong">
                  {money(row.balance)}
                  <span className="sr-only">{tintText(row)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="muted">Nothing moves this account before {formatIsoDate(data.forecast.end)}.</p>}
      {days !== null && earlier.length === 0 && saved.length === 0 && (
        <p className="muted">Nothing is saved for this account in the {days} days before its latest balance.</p>
      )}
      <p className="muted page-note">
        {days !== null && earlier.length > 0 && <>Above the balance: what the bank shows, with each day worked back from the balances saved. </>}
        From the balance of {formatIsoDate(selected.snapshot.date)} to {formatIsoDate(data.forecast.end)}. Estimates are in italics;
        days below the cushion or below zero are tinted.
      </p>
    </>
  );
}
