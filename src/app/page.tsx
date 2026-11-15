import Link from "next/link";
import { Suspense } from "react";
import { TimeZoneForm } from "@/components/accounts/time-zone-form";
import { BalanceChart } from "@/components/forecast/balance-chart";
import { NeedsAttention } from "@/components/forecast/needs-attention";
import { NextDays } from "@/components/forecast/next-days";
import { needsAttention, upcoming } from "@/features/forecast/attention";
import { buildForecast, type AccountSeries } from "@/features/forecast/engine";
import { loadForecastInput } from "@/features/forecast/queries";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { todayIn } from "@/lib/calendar-date";
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
    db.household.findUniqueOrThrow({ where: { id: householdId }, select: { name: true, timeZone: true } }),
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, email: true } }),
  ]);

  return (
    <>
      <p>
        Signed in as <strong>{user.name}</strong> ({user.email}) · household <strong>{household.name}</strong>
      </p>
      {household.timeZone ? (
        <Overview householdId={householdId} timeZone={household.timeZone} chosen={account ?? null} />
      ) : (
        <section className="notice">
          <p>Choose your household&apos;s time zone to see the forecast. It decides what &quot;today&quot; is.</p>
          <TimeZoneForm current={null} zones={Intl.supportedValuesOf("timeZone")} />
        </section>
      )}
      <h2>Pages</h2>
      <ul>
        <li>
          <Link href="/connections">Connections</Link> — link a bank and see its status
        </li>
        <li>
          <Link href="/accounts">Accounts</Link> — balances, with when each was observed
        </li>
        <li>
          <Link href="/accounts/balances">Update balances</Link> — record hand-entered balances as of a date
        </li>
        <li>
          <Link href="/bills">Bills &amp; income</Link> — what comes in and goes out, and when
        </li>
        <li>
          <Link href="/transactions">Transactions</Link> — sync on demand and review recent activity
        </li>
      </ul>
      <SignOutButton />
    </>
  );
}

async function Overview({ householdId, timeZone, chosen }: { householdId: string; timeZone: string; chosen: string | null }) {
  const today = todayIn(timeZone);
  const input = await loadForecastInput(getDb(), householdId, { environment: getPlaidEnvironment(), timeZone, today });
  const forecast = buildForecast(input);
  const charted = forecast.accounts.filter((a): a is AccountSeries => a.kind === "forecast");
  // The account in the address bar is only compared with this household's own list.
  const selected = charted.find((a) => a.account.id === chosen) ?? charted[0] ?? null;

  return (
    <>
      <section aria-labelledby="forecast-heading">
        <h2 id="forecast-heading">Forecast</h2>
        {selected === null ? (
          <p className="muted">
            Add a checking or savings account and its balance to see a forecast: <Link href="/accounts">Accounts</Link> ·{" "}
            <Link href="/accounts/balances">Update balances</Link>
          </p>
        ) : (
          <>
            {charted.length > 1 && (
              <nav aria-label="Accounts in the forecast" className="actions">
                {charted.map((a) =>
                  a === selected ? (
                    <strong key={a.account.id}>{a.account.name}</strong>
                  ) : (
                    <Link key={a.account.id} href={`/?account=${a.account.id}`}>
                      {a.account.name}
                    </Link>
                  ),
                )}
              </nav>
            )}
            <BalanceChart name={selected.account.name} days={selected.days} cushion={selected.cushion} lowest={selected.lowest} />
          </>
        )}
      </section>
      <section aria-labelledby="attention-heading">
        <h2 id="attention-heading">Needs attention</h2>
        <NeedsAttention attention={needsAttention(forecast, input)} />
      </section>
      <section aria-labelledby="next-heading">
        <h2 id="next-heading">Next 7 days</h2>
        <NextDays items={upcoming(forecast, input)} />
      </section>
    </>
  );
}
