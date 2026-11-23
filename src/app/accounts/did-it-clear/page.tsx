import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ClearQuestionItem, clearKey } from "@/components/forecast/did-it-clear";
import { NeedsTimeZone } from "@/components/forecast/forecast-notices";
import { needsAttention } from "@/features/forecast/attention";
import { loadHouseholdForecast } from "@/features/forecast/page-data";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";

export const metadata: Metadata = { title: "Did it clear? · Home Finances" };

export default function DidItClearPage() {
  return (
    <main>
      <p>
        <Link href="/accounts">← Accounts</Link>
      </p>
      <h1>Did it clear?</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Questions />
      </Suspense>
    </main>
  );
}

async function Questions() {
  const { householdId } = await requireHouseholdOrRedirect();
  const data = await loadHouseholdForecast(householdId);
  if (!data.ready) return <NeedsTimeZone />;
  const questions = needsAttention(data.forecast, data.input).didItClear;
  if (questions.length === 0) {
    return (
      <p>
        Nothing to check. <Link href="/accounts">Back to Accounts</Link>
      </p>
    );
  }
  return (
    <>
      <p>
        Your balances may already include these. <strong>Cleared</strong> marks one paid; <strong>Still pending</strong> moves it to
        the day after the balance, so the forecast still counts it.
      </p>
      <ul className="attention" aria-label="Did it clear?">
        {questions.map((q) => (
          <ClearQuestionItem key={clearKey(q)} question={q} back="/accounts/did-it-clear" />
        ))}
      </ul>
      <p>
        <Link href="/accounts">Done</Link>
      </p>
    </>
  );
}
