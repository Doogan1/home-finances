import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { MatchQuestionItem, matchKey } from "@/components/payments/match-question";
import { SyncButton } from "@/components/sync-button";
import { loadPaymentAttention } from "@/features/payments/page-data";
import { getPlaidEnvironment, isPlaidConfigured } from "@/features/plaid/environment";
import { describeSync, formatDate, formatMoney, maskAccount } from "@/features/plaid/format";
import { listRecentTransactions, listSyncStatus } from "@/features/plaid/queries";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { todayIn } from "@/lib/calendar-date";
import { getDb } from "@/lib/db";

export const metadata: Metadata = { title: "Transactions · Home Finances" };

const SHOWN = 200;

export default function TransactionsPage() {
  return (
    <main>
      <h1>Transactions</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Transactions />
      </Suspense>
    </main>
  );
}

async function Transactions() {
  const { householdId } = await requireHouseholdOrRedirect();
  const environment = getPlaidEnvironment();
  const db = getDb();
  const [connections, transactions, household] = await Promise.all([
    listSyncStatus(db, householdId, environment),
    listRecentTransactions(db, householdId, environment, SHOWN),
    db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } }),
  ]);
  const questions = household.timeZone ? (await loadPaymentAttention(householdId, todayIn(household.timeZone))).questions : [];
  const now = new Date();
  const plaidConfigured = isPlaidConfigured();

  return (
    <>
      <p className="muted">
        Transactions are fetched only when you press <strong>Sync now</strong> (or run <code>npm run sync</code>);
        opening this page never contacts Plaid.
      </p>

      {connections.length === 0 ? (
        <p className="muted">
          No banks connected. <Link href="/connections">Connect a bank</Link> first.
        </p>
      ) : (
        <ul className="cards cards-wide">
          {connections.map((connection) => {
            const view = describeSync(
              {
                connectionStatus: connection.status,
                lastRun: connection.syncRuns[0] ?? null,
                lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
              },
              now,
            );
            return (
              <li key={connection.id} className="card">
                <h2>
                  {connection.institutionName ?? "Bank connection"}{" "}
                  <span className={`chip chip-${view.tone}`}>{view.headline}</span>
                </h2>
                {view.detail && <p className="muted">{view.detail}</p>}
                <p>
                  {plaidConfigured && connection.status !== "LOGIN_REQUIRED" ? (
                    <SyncButton connectionId={connection.id} />
                  ) : connection.status === "LOGIN_REQUIRED" ? (
                    <Link href="/connections">Reconnect on Connections</Link>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {questions.length > 0 && (
        <section aria-labelledby="match-heading">
          <h2 id="match-heading">Payments to confirm</h2>
          <p className="muted">
            These look like payments of your bills or income. <strong>Yes</strong> marks that date paid with the real amount and
            day; after that, the same payee is matched for you when the fit is clear.
          </p>
          <ul className="attention panel" aria-label="Payments to confirm">
            {questions.map((q) => (
              <MatchQuestionItem key={matchKey(q)} question={q} />
            ))}
          </ul>
        </section>
      )}

      <h2>Recent transactions</h2>
      {transactions.length === 0 ? (
        <p className="muted">No transactions saved yet.</p>
      ) : (
        <>
          <p className="muted">
            Amounts are shown as the bank reports them: <strong>out</strong> is money leaving the account (purchases,
            payments), <strong>in</strong> is money arriving (deposits, refunds). Pending transactions can still change
            and are replaced when they post. Showing the latest {Math.min(transactions.length, SHOWN)}.
          </p>
          <div className="panel panel-flush">
            <table className="table stack">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Account</th>
                  <th>Bill or income</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => {
                  const outgoing = !t.amount.isNegative();
                  return (
                    <tr key={t.id}>
                      <td className="c-sub">
                        <time dateTime={t.date.toISOString().slice(0, 10)}>{formatDate(t.date)}</time>
                      </td>
                      <td className="c-main">
                        <Link href={`/transactions/${t.id}`}>{t.merchantName ?? t.description}</Link>
                        {t.pending && <span className="chip chip-warn">Pending</span>}
                      </td>
                      <td className="c-sub2">
                        {t.account.name} {maskAccount(t.account.mask)}
                      </td>
                      <td className="c-note">
                        {t.payment && (
                          <>
                            <Link href={`/bills/${t.payment.ruleId}`}>{t.payment.rule.name}</Link>
                            {t.payment.source === "AUTO" && <span className="chip chip-muted">Auto</span>}
                          </>
                        )}
                      </td>
                      <td className={outgoing ? "num c-amt" : "num c-amt money-in"}>
                        {formatMoney(t.amount.abs().toFixed(), t.currency)}{" "}
                        <span className="muted">{outgoing ? "out" : "in"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
