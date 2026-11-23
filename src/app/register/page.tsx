import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccountPicker } from "@/components/forecast/account-picker";
import { NeedsTimeZone, NoForecastAccount } from "@/components/forecast/forecast-notices";
import { money, signedMoney } from "@/components/forecast/money";
import { occurrenceHref } from "@/components/forecast/occurrence-link";
import { StatusChip } from "@/components/forecast/status";
import { tintClass, tintText } from "@/components/forecast/tint";
import { chooseSeries, loadHouseholdForecast } from "@/features/forecast/page-data";
import { registerRows } from "@/features/forecast/register";
import { formatIsoDate } from "@/features/rules/summary";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { toCents } from "@/lib/cents";

export const metadata: Metadata = { title: "Register · Home Finances" };

type SearchParams = Promise<{ account?: string }>;

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
  const { account } = await searchParams;
  const data = await loadHouseholdForecast(householdId);
  if (!data.ready) return <NeedsTimeZone />;
  const selected = chooseSeries(data.charted, account);
  if (!selected) return <NoForecastAccount />;

  const back = `/register?account=${selected.account.id}`;
  const rows = registerRows(selected);
  return (
    <>
      <AccountPicker charted={data.charted} selected={selected} hrefFor={(id) => `/register?account=${id}`} />
      <table className="table" aria-label={`${selected.account.name} register`}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Name</th>
            <th className="num">Amount</th>
            <th className="num">Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{formatIsoDate(selected.snapshot.date)}</td>
            <td>Balance</td>
            <td />
            <td className="num">{money(toCents(selected.snapshot.balance))}</td>
          </tr>
          {rows.map((row) => (
            <tr key={`${row.occurrence.ruleId}-${row.occurrence.scheduledOn}`} className={tintClass(row)}>
              <td>{formatIsoDate(row.date)}</td>
              <td>
                <Link href={occurrenceHref(row.occurrence.ruleId, row.occurrence.scheduledOn, back)}>{row.occurrence.ruleName}</Link>
                <StatusChip status={row.occurrence.status} />
              </td>
              <td className={row.occurrence.estimate ? "num estimate" : "num"} title={row.occurrence.estimate ? "Estimate" : undefined}>
                {signedMoney(row.cents)}
              </td>
              <td className="num">
                {money(row.balance)}
                <span className="sr-only">{tintText(row)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">Nothing moves this account before {formatIsoDate(data.forecast.end)}.</p>}
      <p className="muted">
        From the balance of {formatIsoDate(selected.snapshot.date)} to {formatIsoDate(data.forecast.end)}. Estimates are in italics;
        days below the cushion or below zero are tinted.
      </p>
    </>
  );
}
