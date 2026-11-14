import Link from "next/link";
import { Suspense } from "react";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { SignOutButton } from "./sign-out-button";

// The page itself is static; everything that depends on who is asking streams
// in behind Suspense (reading the session cookie is request-time work, which
// Cache Components does not allow in the prerendered shell).
export default function Home() {
  return (
    <main>
      <h1>Home Finances</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Household />
      </Suspense>
    </main>
  );
}

async function Household() {
  // Re-verified on the server on every request. The proxy's cookie check is
  // only a shortcut for anonymous visitors.
  const { userId, householdId } = await requireHouseholdOrRedirect();

  const db = getDb();
  const [household, user] = await Promise.all([
    db.household.findUniqueOrThrow({ where: { id: householdId }, select: { name: true } }),
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, email: true } }),
  ]);

  return (
    <>
      <p>
        Signed in as <strong>{user.name}</strong> ({user.email}) · household{" "}
        <strong>{household.name}</strong>
      </p>
      <ul>
        <li>
          <Link href="/connections">Connections</Link> — link a bank and see its status
        </li>
        <li>
          <Link href="/accounts">Accounts</Link> — balances, with when each was observed
        </li>
        <li>
          <Link href="/accounts/balances">Update balances</Link> — record hand-entered balances as of a date
        </li>
        <li>
          <Link href="/bills">Bills &amp; income</Link> — what comes in and goes out, and when
        </li>
        <li>
          <Link href="/transactions">Transactions</Link> — sync on demand and review recent activity
        </li>
      </ul>
      <SignOutButton />
    </>
  );
}
