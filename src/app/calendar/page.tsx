import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccountPicker } from "@/components/forecast/account-picker";
import { NeedsTimeZone, NoForecastAccount } from "@/components/forecast/forecast-notices";
import { money, signedMoney } from "@/components/forecast/money";
import { occurrenceHref } from "@/components/forecast/occurrence-link";
import { tintClass, tintText } from "@/components/forecast/tint";
import { calendarMonth, chooseMonth, formatMonth, pastItems, type CalendarDay, type CalendarItem } from "@/features/forecast/calendar";
import { occurrencesBetween } from "@/features/forecast/occurrences";
import { chooseSeries, loadHouseholdForecast, loadPast } from "@/features/forecast/page-data";
import { PAST_MAX_DAYS } from "@/features/forecast/past-queries";
import { listPayments } from "@/features/payments/queries";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { addDays } from "@/lib/calendar-date";
import { getDb } from "@/lib/db";

export const metadata: Metadata = { title: "Calendar · Home Finances" };

type SearchParams = Promise<{ account?: string; month?: string }>;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main>
      <h1>Calendar</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <MonthView searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function MonthView({ searchParams }: { searchParams: SearchParams }) {
  const { householdId } = await requireHouseholdOrRedirect();
  const { account, month: requested } = await searchParams;
  const data = await loadHouseholdForecast(householdId);
  if (!data.ready) return <NeedsTimeZone />;
  const selected = chooseSeries(data.charted, account);
  if (!selected) return <NoForecastAccount />;

  // Before the forecast: what was saved, and what was due (paid dates on the day the bank shows).
  const firstDay = selected.days[0].date;
  const [pastDays, payments] = await Promise.all([
    loadPast(householdId, data, selected, PAST_MAX_DAYS),
    listPayments(getDb(), householdId, { environment: getPlaidEnvironment() }),
  ]);
  const earliest = pastDays[0]?.date;
  const past = {
    days: pastDays,
    items:
      earliest === undefined
        ? new Map<string, CalendarItem[]>()
        : pastItems(occurrencesBetween(data.input.rules, data.input.overrides, earliest, addDays(firstDay, -1)), selected.account.id, firstDay, {
            matched: new Set(payments.map((p) => `${p.ruleId}|${p.scheduledOn}`)),
            hasBank: pastDays.some((day) => day.from === "worked" || day.transactions.length > 0),
          }),
  };
  const month = chooseMonth(selected, requested, data.today, earliest);
  const grid = calendarMonth(selected, month, data.today, past);
  const id = selected.account.id;
  const href = (m: string) => `/calendar?account=${id}&month=${m}`;
  const back = href(month);

  return (
    <>
      <AccountPicker charted={data.charted} selected={selected} hrefFor={(other) => `/calendar?account=${other}&month=${month}`} />
      <nav aria-label="Months" className="months">
        {grid.previous && (
          <Link className="pill" href={href(grid.previous)}>
            ← {formatMonth(grid.previous)}
          </Link>
        )}
        <strong>{formatMonth(month)}</strong>
        {grid.next && (
          <Link className="pill" href={href(grid.next)}>
            {formatMonth(grid.next)} →
          </Link>
        )}
      </nav>
      <div className="panel panel-flush">
        <table className="calendar" aria-label={`${selected.account.name}, ${formatMonth(month)}`}>
          <thead>
            <tr>
              {WEEKDAYS.map((day) => (
                <th key={day} scope="col">
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.weeks.map((week) => (
              <tr key={week[0].date}>
                {week.map((day) => (
                  <Day key={day.date} day={day} back={back} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted page-note">
        End-of-day balances. Estimates are in italics; days below the cushion or below zero are tinted. Before the latest balance,
        a paid item sits on the day the bank shows it, and one with no payment found is marked.
      </p>
    </>
  );
}

function Day({ day, back }: { day: CalendarDay; back: string }) {
  const classes = [day.inMonth ? null : "calendar-outside", day.today ? "calendar-today" : null, tintClass(day)].filter(Boolean).join(" ");
  const weekday = WEEKDAYS[new Date(`${day.date}T00:00:00Z`).getUTCDay()];
  return (
    <td data-date={day.date} className={classes || undefined}>
      <div className="calendar-date">
        <span className="calendar-weekday">{weekday} </span>
        {Number(day.date.slice(8))}
      </div>
      {day.items.length > 0 && (
        <ul>
          {day.items.map((item) => (
            <li key={`${item.occurrence.ruleId}-${item.occurrence.scheduledOn}`}>
              <Link href={occurrenceHref(item.occurrence.ruleId, item.occurrence.scheduledOn, back)}>{item.occurrence.ruleName}</Link>{" "}
              <span className={item.occurrence.estimate ? "estimate" : undefined}>{signedMoney(item.cents)}</span>
              {item.past === "unpaid" && <span className="calendar-unpaid"> no payment found</span>}
              {item.past === "hand" && <span className="sr-only"> (marked paid)</span>}
            </li>
          ))}
        </ul>
      )}
      {day.closing !== null && (
        <div className="calendar-balance">
          {money(day.closing)}
          <span className="sr-only">{tintText(day)}</span>
        </div>
      )}
    </td>
  );
}
