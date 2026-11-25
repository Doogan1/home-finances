import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { NeedsTimeZone } from "@/components/forecast/forecast-notices";
import { money, signedMoney } from "@/components/forecast/money";
import { safeBack } from "@/components/forecast/occurrence-link";
import { OccurrenceForm, ResetEditButton } from "@/components/forecast/occurrence-form";
import { UndoMatchButton } from "@/components/payments/match-buttons";
import { STATUS_LABELS } from "@/components/forecast/status";
import { isCashAccount } from "@/features/forecast/engine";
import { occurrenceAt } from "@/features/forecast/occurrences";
import { loadHouseholdForecast } from "@/features/forecast/page-data";
import { listPayments } from "@/features/payments/queries";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import { accountLookup, listOverrides } from "@/features/rules/queries";
import { formatIsoDate } from "@/features/rules/summary";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { parseIsoDate } from "@/lib/calendar-date";
import { getDb } from "@/lib/db";

export const metadata: Metadata = { title: "Occurrence · Home Finances" };

type Params = Promise<{ ruleId: string; date: string }>;
type SearchParams = Promise<{ back?: string }>;

export default function OccurrencePage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  return (
    <main>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Occurrence params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Occurrence({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { ruleId, date } = await params;
  const back = safeBack((await searchParams).back);
  if (!z.uuid().safeParse(ruleId).success || !parseIsoDate(date)) notFound();
  const { householdId } = await requireHouseholdOrRedirect();
  const data = await loadHouseholdForecast(householdId);
  if (!data.ready) return <NeedsTimeZone />;

  // The forecast's rules are this household's own, not archived.
  const rule = data.input.rules.find((r) => r.id === ruleId);
  if (!rule) notFound();
  const db = getDb();
  const [edits, accounts, rulePayments] = await Promise.all([
    listOverrides(db, householdId, ruleId),
    accountLookup(db, householdId),
    listPayments(db, householdId, { environment: getPlaidEnvironment() }, ruleId),
  ]);
  const payments = rulePayments.filter((p) => p.scheduledOn === date);
  const edit = edits.find((e) => e.scheduledOn === date) ?? null;
  const occurrence = occurrenceAt(rule, data.input.overrides, date);
  if (!occurrence && !edit) notFound();

  const header = (
    <>
      <p className="back">
        <Link href={back}>← Back</Link>
      </p>
      <h1>{rule.name}</h1>
    </>
  );
  if (!occurrence) {
    return (
      <>
        {header}
        <section className="notice notice-warn">
          <p>
            There is an edit for {formatIsoDate(date)}, a date this no longer produces. It is kept until you reset it.
          </p>
          <ResetEditButton ruleId={rule.id} scheduledOn={date} back={back} />
        </section>
      </>
    );
  }

  const version = rule.versions.find((v) => v.id === occurrence.versionId);
  if (!version) notFound();
  const shares = occurrence.shares.map((share) => {
    const account = accounts.get(share.accountId);
    const name = account?.name ?? "Unknown account";
    const cents = occurrence.kind === "INCOME" ? share.cents : -share.cents;
    return account && !isCashAccount(account) ? `${name} ${money(share.cents)} (no cash moves)` : `${name} ${signedMoney(cents)}`;
  });
  return (
    <>
      {header}
      <p className="muted">
        {occurrence.kind === "INCOME" ? "Income" : "Bill"} · scheduled for {formatIsoDate(occurrence.scheduledOn)}
        {occurrence.date !== occurrence.scheduledOn && ` · moved to ${formatIsoDate(occurrence.date)}`} ·{" "}
        {STATUS_LABELS[occurrence.status]} · <Link href={`/bills/${rule.id}`}>All its dates</Link>
      </p>
      <p className="lead">
        <span className={occurrence.estimate ? "estimate" : undefined}>{money(occurrence.amount)}</span>
        {occurrence.estimate ? " (estimate)" : " (confirmed)"} · {shares.join(" · ")}
      </p>
      {payments.length > 0 ? (
        <section className="notice notice-ok" aria-label="Payments">
          <p>The bank shows this paid, so the forecast uses the real amount and day:</p>
          <ul>
            {payments.map((p) => (
              <li key={p.id}>
                <Link href={`/transactions/${p.transactionId}`}>{p.payee}</Link>, {money(p.cents)} on {formatIsoDate(p.date)},{" "}
                {accounts.get(p.accountId)?.name ?? "Unknown account"}{" "}
                {p.source === "AUTO" && <span className="chip chip-muted">Auto</span>} <UndoMatchButton transactionId={p.transactionId} />
              </li>
            ))}
          </ul>
          <p className="muted">To change this date by hand, undo the match first. Your own edit, if you made one, comes back.</p>
        </section>
      ) : (
        <OccurrenceForm
          ruleId={rule.id}
          scheduledOn={date}
          estimate={rule.typical && date >= rule.typical.from ? rule.typical.amount : version.amount}
          current={edit && { status: edit.status, confirmedAmount: edit.confirmedAmount, movedTo: edit.movedTo, note: edit.note }}
          input={data.input}
          back={back}
        />
      )}
    </>
  );
}
