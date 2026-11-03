import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import {
  STALE_AFTER_MS,
  describeAge,
  formatMoney,
  formatTimestamp,
  maskAccount,
} from "@/features/plaid/format";
import { listAccountsWithLatestBalance } from "@/features/plaid/queries";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { getDb } from "@/lib/db";

export const metadata: Metadata = { title: "Accounts · Home Finances" };

export default function AccountsPage() {
  return (
    <main>
      <p>
        <Link href="/">← Home</Link>
      </p>
      <h1>Accounts</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Accounts />
      </Suspense>
    </main>
  );
}

// What each balance means depends on the kind of account. For credit and loan
// accounts Plaid reports "current" as the amount owed.
function balanceLabels(type: string) {
  return type === "credit" || type === "loan"
    ? { current: "Owed", available: "Available credit", limit: "Limit" }
    : { current: "Current", available: "Available", limit: "Limit" };
}

async function Accounts() {
  const { householdId } = await requireHouseholdOrRedirect();
  const accounts = await listAccountsWithLatestBalance(getDb(), householdId, getPlaidEnvironment());
  const now = new Date();

  if (accounts.length === 0) {
    return (
      <p className="muted">
        No accounts yet. <Link href="/connections">Connect a bank</Link> first.
      </p>
    );
  }

  return (
    <ul className="cards">
      {accounts.map((account) => {
        const balance = account.balances[0] ?? null;
        const labels = balanceLabels(account.type);
        const stale = balance !== null && now.getTime() - balance.observedAt.getTime() > STALE_AFTER_MS;
        return (
          <li key={account.id} className="card">
            <h2>
              {account.name} <span className="muted">{maskAccount(account.mask)}</span>
              {!account.active && <span className="chip chip-muted">Not reported by bank</span>}
            </h2>
            <p className="muted">
              {account.plaidItem.institutionName ?? "Bank"} · {account.subtype ?? account.type}
            </p>
            {balance ? (
              <>
                <dl className="balances">
                  <div>
                    <dt>{labels.current}</dt>
                    <dd>{formatMoney(balance.current?.toFixed() ?? null, balance.currency)}</dd>
                  </div>
                  <div>
                    <dt>{labels.available}</dt>
                    <dd>{formatMoney(balance.available?.toFixed() ?? null, balance.currency)}</dd>
                  </div>
                  {balance.limit !== null && (
                    <div>
                      <dt>{labels.limit}</dt>
                      <dd>{formatMoney(balance.limit.toFixed(), balance.currency)}</dd>
                    </div>
                  )}
                </dl>
                <p className="muted">
                  As of{" "}
                  <time dateTime={balance.observedAt.toISOString()}>{formatTimestamp(balance.observedAt)}</time> (
                  {describeAge(balance.observedAt, now)})
                  {stale && <span className="chip chip-warn">May be out of date</span>}
                  {account.unavailableSince && (
                    <> · bank stopped reporting this account {formatTimestamp(account.unavailableSince)}</>
                  )}
                </p>
              </>
            ) : (
              <p className="muted">No balance recorded yet.</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
