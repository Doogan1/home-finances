import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { ChooseMatchForm, UndoMatchButton } from "@/components/payments/match-buttons";
import { loadTransactionMatch } from "@/features/payments/queries";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import { formatMoney } from "@/features/plaid/format";
import { formatIsoDate } from "@/features/rules/summary";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { todayIn } from "@/lib/calendar-date";
import { getDb } from "@/lib/db";

export const metadata: Metadata = { title: "Transaction · Home Finances" };

type Params = Promise<{ id: string }>;

export default function TransactionPage({ params }: { params: Params }) {
  return (
    <main>
      <p className="back">
        <Link href="/transactions">← Transactions</Link>
      </p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Transaction params={params} />
      </Suspense>
    </main>
  );
}

async function Transaction({ params }: { params: Params }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { householdId } = await requireHouseholdOrRedirect();
  const db = getDb();
  const { timeZone } = await db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } });
  const match = await loadTransactionMatch(db, householdId, id, {
    environment: getPlaidEnvironment(),
    today: timeZone ? todayIn(timeZone) : null,
  });
  if (!match) notFound();

  const { transaction, payment } = match;
  const outgoing = !transaction.amount.startsWith("-");
  const amount = formatMoney(transaction.amount.replace(/^-/, ""), transaction.currency);
  const choices = match.choices.map((choice) => ({
    ruleId: choice.ruleId,
    name: choice.name,
    dates: choice.dates.map((d) => ({
      scheduledOn: d.scheduledOn,
      label: `Due ${formatIsoDate(d.scheduledOn)}${d.date !== d.scheduledOn ? ` (moved to ${formatIsoDate(d.date)})` : ""}${d.paid ? " · already has a payment" : ""}`,
    })),
  }));

  return (
    <>
      <h1>{transaction.payee}</h1>
      <p className="muted">
        {formatIsoDate(transaction.date)} · {transaction.accountName}
        {transaction.payee !== transaction.description && ` · ${transaction.description}`}
      </p>
      <p className="lead">
        <span className={outgoing ? undefined : "money-in"}>{amount}</span> {outgoing ? "out" : "in"}{" "}
        {transaction.pending && <span className="chip chip-warn">Pending</span>}
      </p>

      {payment ? (
        <section className="notice notice-ok" aria-label="Match">
          <p>
            {outgoing ? "Paid" : "Was"} <Link href={`/bills/${payment.ruleId}`}>{payment.ruleName}</Link>
            {payment.scheduledOn ? `, due ${formatIsoDate(payment.scheduledOn)}` : ", with no due date (kept as history)"}.{" "}
            {payment.source === "AUTO" ? "Matched automatically, because you confirmed this payee for it before." : "Matched by hand."}
          </p>
          <p className="actions">
            <UndoMatchButton transactionId={transaction.id} />
          </p>
          <p className="muted">Undoing puts that date back to what it was. To match it to something else, undo first.</p>
        </section>
      ) : !match.canMatch ? (
        <p className="muted">
          {transaction.pending
            ? "This is still pending. It can be matched to a bill once it posts."
            : "This account only comes from the bank. Attach it to one of your own accounts on Connections to match its transactions to bills."}
        </p>
      ) : choices.length === 0 ? (
        <p className="muted">
          No {outgoing ? "bill" : "income"} uses {transaction.accountName}, so there is nothing to match this to.{" "}
          <Link href={`/bills/new?kind=${outgoing ? "bill" : "income"}`}>Add one</Link>
        </p>
      ) : (
        <section aria-labelledby="match-heading">
          <h2 id="match-heading">Match to a {outgoing ? "bill" : "bill or income"}</h2>
          <p className="muted">
            Matching marks that date paid with this amount and day. After you match a payee once, later payments to it are matched for
            you when the fit is clear.
          </p>
          <ChooseMatchForm transactionId={transaction.id} choices={choices} suggested={match.suggested} />
        </section>
      )}
    </>
  );
}
