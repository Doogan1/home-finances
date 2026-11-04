import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PlaidLinkButton } from "@/components/plaid-link";
import { ConnectionActions } from "@/components/connection-actions";
import { getPlaidEnvironment, isPlaidConfigured } from "@/features/plaid/environment";
import { describeConnection, formatTimestamp } from "@/features/plaid/format";
import { listConnections } from "@/features/plaid/queries";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { getDb } from "@/lib/db";

export const metadata: Metadata = { title: "Connections · Home Finances" };

export default function ConnectionsPage() {
  return (
    <main>
      <p>
        <Link href="/">← Home</Link>
      </p>
      <h1>Connections</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Connections />
      </Suspense>
    </main>
  );
}

async function Connections() {
  const { householdId } = await requireHouseholdOrRedirect();
  const environment = getPlaidEnvironment();
  const connections = await listConnections(getDb(), householdId, environment);
  const plaidConfigured = isPlaidConfigured();

  return (
    <>
      <p className="muted">
        Environment: <strong>{environment === "SANDBOX" ? "Plaid Sandbox (test data, no real bank)" : "Production"}</strong>
      </p>

      {plaidConfigured ? (
        <PlaidLinkButton />
      ) : (
        <p className="notice notice-warn">
          Plaid is not configured. Set <code>PLAID_CLIENT_ID</code> and <code>PLAID_SECRET</code> in <code>.env</code>{" "}
          and recreate the app container.
        </p>
      )}

      {connections.length === 0 ? (
        <p className="muted">No banks connected yet.</p>
      ) : (
        <ul className="cards">
          {connections.map((connection) => {
            const view = describeConnection(connection.status, connection.lastErrorCode);
            const activeAccounts = connection.accounts.filter((account) => account.active).length;
            const savedAccounts = connection.accounts.length;
            const disconnected = connection.status === "DISCONNECTED";
            return (
              <li key={connection.id} className="card">
                <h2>
                  {connection.institutionName ?? "Bank connection"}{" "}
                  <span className={`chip chip-${view.tone}`}>{view.label}</span>
                </h2>
                <p className="muted">
                  Connected {formatTimestamp(connection.createdAt)} ·{" "}
                  {disconnected
                    ? `${savedAccounts} saved ${savedAccounts === 1 ? "account" : "accounts"}`
                    : `${activeAccounts} ${activeAccounts === 1 ? "account" : "accounts"}`}
                </p>
                {view.advice && <p>{view.advice}</p>}
                {savedAccounts > 0 && (
                  <p>
                    <Link href="/accounts">View accounts</Link>
                  </p>
                )}
                <ConnectionActions
                  connectionId={connection.id}
                  status={connection.status}
                  institutionName={connection.institutionName ?? "this bank"}
                  savedAccounts={savedAccounts}
                  plaidConfigured={plaidConfigured}
                />
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
