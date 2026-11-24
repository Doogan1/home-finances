import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccountEditor } from "@/components/accounts/account-editor";
import { NewAccountForm } from "@/components/accounts/new-account-form";
import { TimeZoneForm } from "@/components/accounts/time-zone-form";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import {
  STALE_AFTER_MS,
  describeAge,
  formatDate,
  formatMoney,
  formatTimestamp,
  maskAccount,
} from "@/features/plaid/format";
import { listAccountsWithLatestBalance } from "@/features/plaid/queries";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { daysBetween, todayIn, toIsoDate } from "@/lib/calendar-date";
import { getDb } from "@/lib/db";

export const metadata: Metadata = { title: "Accounts · Home Finances" };

export default function AccountsPage() {
  return (
    <main>
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
  const db = getDb();
  const household = await db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } });
  const accounts = await listAccountsWithLatestBalance(db, householdId, getPlaidEnvironment(), household.timeZone);
  const now = new Date();
  const today = household.timeZone ? todayIn(household.timeZone, now) : null;

  const timeZone = (
    <section className="notice">
      {household.timeZone ? (
        <p>
          Time zone: {household.timeZone} · <Link href="/accounts/balances">Update balances</Link>
        </p>
      ) : (
        <p>Choose your household&apos;s time zone. It decides what &quot;today&quot; is for balances and the forecast.</p>
      )}
      <TimeZoneForm current={household.timeZone} zones={Intl.supportedValuesOf("timeZone")} />
    </section>
  );

  return (
    <>
      {!household.timeZone && timeZone}
      <NewAccountForm />
      {accounts.length === 0 ? (
        <p className="muted">
          No accounts yet. Add one by hand, or <Link href="/connections">connect a bank</Link>.
        </p>
      ) : (
        <ul className="cards cards-wide">
          {accounts.map((account) => {
            const balance = account.balance;
            const labels = balanceLabels(account.type);
            const manual = account.plaidItem === null;
            const attached = account.attachedAt !== null;
            const disconnected = account.plaidItem?.status === "DISCONNECTED";
            const bank = account.plaidItem?.institutionName ?? "Bank";
            const archived = account.archivedAt !== null;
            // A typed-in balance is true at the end of its as-of date; a bank one
            // is dated by when it was observed. Which one is shown decides how.
            const typedAsOf = balance?.source === "MANUAL" && balance.asOfDate ? toIsoDate(balance.asOfDate) : null;
            const stale = balance
              ? typedAsOf
                ? today !== null && daysBetween(typedAsOf, today) > 7
                : now.getTime() - balance.observedAt.getTime() > STALE_AFTER_MS
              : false;
            return (
              <li key={account.id} className="card">
                <h2>
                  {account.name} {!manual && <span className="muted">{maskAccount(account.mask)}</span>}
                  {account.ownerLabel && <span className="chip">{account.ownerLabel}</span>}
                  {archived && <span className="chip chip-muted">Archived</span>}
                  {attached && disconnected && <span className="chip chip-muted">Bank disconnected · enter balances by hand</span>}
                  {!manual && !account.active && !(attached && disconnected) && (
                    <span className="chip chip-muted">{disconnected ? "Disconnected · history kept" : "Not reported by bank"}</span>
                  )}
                </h2>
                <p className="muted">
                  {manual ? "Entered by hand" : attached ? `Entered by hand, attached to ${bank}` : bank} ·{" "}
                  {account.subtype ?? account.type}
                  {account.cushion !== null && <> · cushion {formatMoney(account.cushion.toFixed(), account.currency)}</>}
                </p>
                {balance ? (
                  <>
                    <dl className="balances">
                      <div>
                        <dt>{labels.current}</dt>
                        <dd>{formatMoney(balance.current?.toFixed() ?? null, balance.currency)}</dd>
                      </div>
                      {typedAsOf === null && (
                        <div>
                          <dt>{labels.available}</dt>
                          <dd>{formatMoney(balance.available?.toFixed() ?? null, balance.currency)}</dd>
                        </div>
                      )}
                      {balance.limit !== null && (
                        <div>
                          <dt>{labels.limit}</dt>
                          <dd>{formatMoney(balance.limit.toFixed(), balance.currency)}</dd>
                        </div>
                      )}
                    </dl>
                    <p className="muted">
                      As of{" "}
                      {typedAsOf && balance.asOfDate ? (
                        <time dateTime={typedAsOf}>{formatDate(balance.asOfDate)}</time>
                      ) : (
                        <>
                          <time dateTime={balance.observedAt.toISOString()}>{formatTimestamp(balance.observedAt)}</time> (
                          {describeAge(balance.observedAt, now)})
                        </>
                      )}
                      {stale && !archived && <span className="chip chip-warn">May be out of date</span>}
                      {balance.note && <> · {balance.note}</>}
                      {account.unavailableSince && (
                        <>
                          {" "}
                          · {disconnected ? "disconnected" : "bank stopped reporting this account"}{" "}
                          {formatTimestamp(account.unavailableSince)}
                        </>
                      )}
                    </p>
                  </>
                ) : (
                  <p className="muted">No balance recorded yet.</p>
                )}
                {!archived && (
                  <AccountEditor
                    id={account.id}
                    manual={manual}
                    renamable={manual || attached}
                    isCash={account.type === "depository"}
                    name={account.name}
                    ownerLabel={account.ownerLabel}
                    cushion={account.cushion?.toFixed() ?? null}
                    includeInForecast={account.includeInForecast}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {household.timeZone && timeZone}
    </>
  );
}
