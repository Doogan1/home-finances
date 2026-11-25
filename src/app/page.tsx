import { Suspense } from "react";
import { AccountPicker } from "@/components/forecast/account-picker";
import { NeedsTimeZone, NoForecastAccount } from "@/components/forecast/forecast-notices";
import { ForecastStats } from "@/components/forecast/forecast-stats";
import { NeedsAttention } from "@/components/forecast/needs-attention";
import { BalanceChart, type ChartedDay } from "@/components/forecast/balance-chart";
import { money, signedMoney } from "@/components/forecast/money";
import { NextDays } from "@/components/forecast/next-days";
import { needsAttention, upcoming } from "@/features/forecast/attention";
import type { AccountSeries } from "@/features/forecast/engine";
import { chooseSeries, loadHouseholdForecast, loadPast } from "@/features/forecast/page-data";
import type { PastDay } from "@/features/forecast/past";
import { PAST_CHART_DAYS } from "@/features/forecast/past-queries";
import { loadPaymentAttention } from "@/features/payments/page-data";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { getDb } from "@/lib/db";

type SearchParams = Promise<{ account?: string }>;

/** A past day tells the chart's read-out what really moved: up to three transactions, by bill name when matched. */
const NOTES_SHOWN = 3;
function pastChartDays(past: readonly PastDay[], series: AccountSeries): ChartedDay[] {
  return past.map((day) => {
    const notes = day.transactions.slice(0, NOTES_SHOWN).map((t) => `${t.ruleName ?? t.payee} ${signedMoney(t.cents)}`);
    if (day.transactions.length > NOTES_SHOWN) notes.push(`${day.transactions.length - NOTES_SHOWN} more`);
    return {
      date: day.date,
      closing: day.closing,
      belowZero: day.closing < 0n,
      belowCushion: series.cushion !== null && day.closing < series.cushion,
      past: true,
      notes,
    };
  });
}

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
      <Overview householdId={householdId} chosen={account} />
      <p className="page-foot">
        Signed in as <strong>{user.name}</strong> ({user.email}) · household <strong>{household.name}</strong>
      </p>
    </>
  );
}

async function Overview({ householdId, chosen }: { householdId: string; chosen: string | undefined }) {
  const data = await loadHouseholdForecast(householdId);
  if (!data.ready) return <NeedsTimeZone />;
  const selected = chooseSeries(data.charted, chosen);
  const [payments, past] = await Promise.all([
    loadPaymentAttention(householdId, data.today),
    selected ? loadPast(householdId, data, selected, PAST_CHART_DAYS) : [],
  ]);
  const differ = payments.differ.map((d) => ({
    ruleId: d.ruleId,
    ruleName: d.ruleName,
    planned: money(d.planned),
    typical: money(d.typical.cents),
    count: d.typical.count,
  }));

  return (
    <>
      <section aria-labelledby="forecast-heading" className="panel">
        <h2 id="forecast-heading" className="sr-only">
          Forecast
        </h2>
        {selected === null ? (
          <NoForecastAccount />
        ) : (
          <>
            <AccountPicker charted={data.charted} selected={selected} hrefFor={(id) => `/?account=${id}`} />
            <ForecastStats series={selected} today={data.today} />
            <BalanceChart
              name={selected.account.name}
              days={[...pastChartDays(past, selected), ...selected.days]}
              cushion={selected.cushion}
              lowest={selected.lowest}
              today={data.today}
            />
          </>
        )}
      </section>
      <div className="split">
        <section aria-labelledby="attention-heading" className="panel">
          <h2 id="attention-heading">Needs attention</h2>
          <NeedsAttention attention={needsAttention(data.forecast, data.input)} questions={payments.questions} differ={differ} />
        </section>
        <section aria-labelledby="next-heading" className="panel">
          <h2 id="next-heading">Next 7 days</h2>
          <NextDays items={upcoming(data.forecast, data.input)} />
        </section>
      </div>
    </>
  );
}
