import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AttachAccount } from "@/components/attach-account";
import { ConnectionActions } from "@/components/connection-actions";
import { PlaidLinkButton } from "@/components/plaid-link";
import { listAttachCandidates } from "@/features/accounts/attach";
import { attachTargets } from "@/features/accounts/linking";
import { getPlaidEnvironment, isPlaidConfigured } from "@/features/plaid/environment";
import { describeConnection, formatTimestamp, maskAccount } from "@/features/plaid/format";
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
  const db = getDb();
  const [connections, candidates] = await Promise.all([
    listConnections(db, householdId, environment),
    listAttachCandidates(db, householdId),
  ]);
  const plaidConfigured = isPlaidConfigured();

  return (
    <>
      {environment === "SANDBOX" ? (
        <p className="muted">
          Environment: <strong>Plaid Sandbox</strong> (test data, no real bank)
        </p>
      ) : (
        <p className="notice notice-warn" role="note">
          <strong>Production: real bank data.</strong> Banks connected here are real accounts. Sandbox connections are
          not shown.
        </p>
      )}

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
            const institutionName = connection.institutionName ?? "this bank";
            const attachedNames = connection.accounts.filter((account) => account.attachedAt !== null).map((account) => account.name);
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
                  <>
                    <ul>
                      {connection.accounts.map((account) => {
                        if (account.attachedAt !== null) {
                          return (
                            <li key={account.id}>
                              {maskAccount(account.mask)} attached to <strong>{account.name}</strong>
                            </li>
                          );
                        }
                        // A disconnected bank's accounts are history only, and one the bank stopped reporting cannot be attached: nothing to offer.
                        const targets = disconnected || !account.active ? [] : attachTargets(account.type, candidates);
                        return (
                          <li key={account.id}>
                            {account.name}{" "}
                            <span className="muted">
                              {maskAccount(account.mask)} · {account.subtype ?? account.type}
                            </span>
                            {targets.length > 0 && (
                              <AttachAccount
                                bankAccount={{ id: account.id, label: `${account.name} ${maskAccount(account.mask)}` }}
                                institutionName={institutionName}
                                targets={targets.map(({ id, name }) => ({ id, name }))}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <p>
                      <Link href="/accounts">View accounts</Link>
                    </p>
                  </>
                )}
                <ConnectionActions
                  connectionId={connection.id}
                  status={connection.status}
                  institutionName={institutionName}
                  savedAccounts={savedAccounts - attachedNames.length}
                  attachedNames={attachedNames}
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
