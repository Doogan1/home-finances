import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccountPicker } from "@/components/forecast/account-picker";
import { NeedsTimeZone, NoForecastAccount } from "@/components/forecast/forecast-notices";
import { money, signedMoney } from "@/components/forecast/money";
import { occurrenceHref } from "@/components/forecast/occurrence-link";
import { tintClass, tintText } from "@/components/forecast/tint";
import { calendarMonth, chooseMonth, formatMonth, type CalendarDay } from "@/features/forecast/calendar";
import { chooseSeries, loadHouseholdForecast } from "@/features/forecast/page-data";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";

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

  const month = chooseMonth(selected, requested, data.today);
  const grid = calendarMonth(selected, month, data.today);
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
      <p className="muted page-note">End-of-day balances. Estimates are in italics; days below the cushion or below zero are tinted.</p>
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
