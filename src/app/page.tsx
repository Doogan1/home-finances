import Link from "next/link";
import { Suspense } from "react";
import { AccountPicker } from "@/components/forecast/account-picker";
import { BalanceChart } from "@/components/forecast/balance-chart";
import { NeedsTimeZone, NoForecastAccount } from "@/components/forecast/forecast-notices";
import { NeedsAttention } from "@/components/forecast/needs-attention";
import { NextDays } from "@/components/forecast/next-days";
import { needsAttention, upcoming } from "@/features/forecast/attention";
import { chooseSeries, loadHouseholdForecast } from "@/features/forecast/page-data";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { SignOutButton } from "./sign-out-button";

type SearchParams = Promise<{ account?: string }>;

// The page itself is static; everything that depends on who is asking streams
// in behind Suspense (reading the session cookie is request-time work, which
// Cache Components does not allow in the prerendered shell).
export default function Home({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main>
      <h1>Home Finances</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Household searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Household({ searchParams }: { searchParams: SearchParams }) {
  // Re-verified on the server on every request. The proxy's cookie check is
  // only a shortcut for anonymous visitors.
  const { userId, householdId } = await requireHouseholdOrRedirect();
  const { account } = await searchParams;

  const db = getDb();
  const [household, user] = await Promise.all([
    db.household.findUniqueOrThrow({ where: { id: householdId }, select: { name: true } }),
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, email: true } }),
  ]);

  return (
    <>
      <p>
        Signed in as <strong>{user.name}</strong> ({user.email}) · household <strong>{household.name}</strong>
      </p>
      <Overview householdId={householdId} chosen={account} />
      <h2>More</h2>
      <ul>
        <li>
          <Link href="/accounts/balances">Update balances</Link> — record hand-entered balances as of a date
        </li>
        <li>
          <Link href="/transactions">Transactions</Link> — sync on demand and review recent activity
        </li>
      </ul>
      <SignOutButton />
    </>
  );
}

async function Overview({ householdId, chosen }: { householdId: string; chosen: string | undefined }) {
  const data = await loadHouseholdForecast(householdId);
  if (!data.ready) return <NeedsTimeZone />;
  const selected = chooseSeries(data.charted, chosen);

  return (
    <>
      <section aria-labelledby="forecast-heading">
        <h2 id="forecast-heading">Forecast</h2>
        {selected === null ? (
          <NoForecastAccount />
        ) : (
          <>
            <AccountPicker charted={data.charted} selected={selected} hrefFor={(id) => `/?account=${id}`} />
            <BalanceChart name={selected.account.name} days={selected.days} cushion={selected.cushion} lowest={selected.lowest} />
          </>
        )}
      </section>
      <section aria-labelledby="attention-heading">
        <h2 id="attention-heading">Needs attention</h2>
        <NeedsAttention attention={needsAttention(data.forecast, data.input)} />
      </section>
      <section aria-labelledby="next-heading">
        <h2 id="next-heading">Next 7 days</h2>
        <NextDays items={upcoming(data.forecast, data.input)} />
      </section>
    </>
  );
}
