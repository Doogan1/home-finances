import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BalancesForm, type BalanceRow } from "@/components/accounts/balances-form";
import { TimeZoneForm } from "@/components/accounts/time-zone-form";
import { latestBalances } from "@/features/accounts/latest-balance";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import { formatDate, formatMoney, formatTimestamp } from "@/features/plaid/format";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { todayIn } from "@/lib/calendar-date";
import { getDb } from "@/lib/db";

export const metadata: Metadata = { title: "Update balances · Home Finances" };

export default function UpdateBalancesPage() {
  return (
    <main>
      <p>
        <Link href="/accounts">← Accounts</Link>
      </p>
      <h1>Update balances</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Balances />
      </Suspense>
    </main>
  );
}

async function Balances() {
  const { householdId } = await requireHouseholdOrRedirect();
  const db = getDb();
  const environment = getPlaidEnvironment();
  const household = await db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } });

  if (!household.timeZone) {
    return (
      <section className="notice">
        <p>Choose your household&apos;s time zone first. It decides what &quot;today&quot; is.</p>
        <TimeZoneForm current={null} zones={Intl.supportedValuesOf("timeZone")} />
      </section>
    );
  }
  const timeZone = household.timeZone;
  // Not archived. Plaid-linked accounts (current Plaid environment only) are
  // listed read-only: their balances come from the bank.
  const accounts = await db.account.findMany({
    where: { householdId, archivedAt: null, OR: [{ plaidItemId: null }, { plaidItem: { environment } }] },
    orderBy: { name: "asc" },
  });
  if (accounts.length === 0) {
    return (
      <p className="muted">
        No accounts yet. <Link href="/accounts">Add one</Link> first.
      </p>
    );
  }
  const latest = await latestBalances(db, accounts.map((account) => account.id), timeZone);

  const rows: BalanceRow[] = accounts.map((account) => {
    const last = latest.get(account.id);
    return {
      id: account.id,
      name: account.name,
      ownerLabel: account.ownerLabel,
      owedLabel: account.type === "credit",
      synced: account.plaidItemId !== null,
      last: last
        ? {
            amount: formatMoney(last.current?.toFixed() ?? null, last.currency),
            asOf: last.source === "MANUAL" && last.asOfDate ? formatDate(last.asOfDate) : formatTimestamp(last.observedAt),
          }
        : null,
    };
  });
  return <BalancesForm rows={rows} today={todayIn(timeZone)} />;
}
