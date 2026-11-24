import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { RuleForm } from "@/components/rules/rule-form";
import { listAccountChoices } from "@/features/rules/queries";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { getDb } from "@/lib/db";

export const metadata: Metadata = { title: "Add a bill or income · Home Finances" };

type SearchParams = Promise<{ kind?: string }>;

export default function NewRulePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main>
      <p className="back">
        <Link href="/bills">← Bills &amp; income</Link>
      </p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <NewRule searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function NewRule({ searchParams }: { searchParams: SearchParams }) {
  const { kind } = await searchParams;
  const ruleKind = kind === "income" ? "INCOME" : "BILL";
  const { householdId } = await requireHouseholdOrRedirect();
  const accounts = await listAccountChoices(getDb(), householdId);
  return (
    <>
      <h1>{ruleKind === "INCOME" ? "Add income" : "Add a bill"}</h1>
      {accounts.length === 0 ? (
        <p className="muted">
          No accounts entered by hand yet. <Link href="/accounts">Add one</Link> first.
        </p>
      ) : (
        <RuleForm kind={ruleKind} accounts={accounts} />
      )}
    </>
  );
}
