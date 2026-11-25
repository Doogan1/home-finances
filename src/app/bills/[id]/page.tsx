import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { TimeZoneForm } from "@/components/accounts/time-zone-form";
import { occurrenceHref } from "@/components/forecast/occurrence-link";
import { STATUS_LABELS } from "@/components/forecast/status";
import { money, signedMoney } from "@/components/forecast/money";
import { ArchiveRuleButton } from "@/components/rules/archive-rule-button";
import { ChangeFromForm } from "@/components/rules/change-from-form";
import { EditVersionForm } from "@/components/rules/edit-version-form";
import { EstimateModeForm } from "@/components/rules/estimate-mode-form";
import { RuleDetailsForm } from "@/components/rules/rule-details-form";
import { StopForm } from "@/components/rules/stop-form";
import { differs } from "@/features/payments/differ";
import { paymentHistory, type HistoryRow } from "@/features/payments/history";
import { TYPICAL_NEEDS, paymentTotals, usableTypical, type Typical } from "@/features/payments/layer";
import { listPayments, toLayerPayment } from "@/features/payments/queries";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import { formatMoney } from "@/features/plaid/format";
import type { AccountChoice } from "@/features/rules/form-drafts";
import { accountLookup, getRule, listAccountChoices, listOverrides, type OverrideView, type RuleView } from "@/features/rules/queries";
import { nextOccurrences, ruleOccurrences } from "@/features/rules/recurrence";
import { splitAmount } from "@/features/rules/splits";
import { describeAllocations, describeSchedule, formatIsoDate, latestVersion, ruleState, versionFor } from "@/features/rules/summary";
import type { StoredVersion } from "@/features/rules/versions";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { addDays, todayIn, type IsoDate } from "@/lib/calendar-date";
import { fromCents, toCents } from "@/lib/cents";
import { getDb } from "@/lib/db";

export const metadata: Metadata = { title: "Bill or income · Home Finances" };

type Params = Promise<{ id: string }>;
type NameOf = (accountId: string) => string;

export default function RulePage({ params }: { params: Params }) {
  return (
    <main>
      <p className="back">
        <Link href="/bills">← Bills &amp; income</Link>
      </p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Rule params={params} />
      </Suspense>
    </main>
  );
}

async function Rule({ params }: { params: Params }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { householdId } = await requireHouseholdOrRedirect();
  const db = getDb();
  const [rule, household, accounts, choices, overrides, payments] = await Promise.all([
    getRule(db, householdId, id),
    db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } }),
    accountLookup(db, householdId),
    listAccountChoices(db, householdId),
    listOverrides(db, householdId, id),
    listPayments(db, householdId, { environment: getPlaidEnvironment() }, id),
  ]);
  if (!rule) notFound();

  const today = household.timeZone ? todayIn(household.timeZone) : null;
  const nameOf: NameOf = (accountId) => accounts.get(accountId)?.name ?? "Unknown account";
  const latest = latestVersion(rule.versions);
  const state = today ? ruleState(rule, today) : null;
  const forecastRule = { id: rule.id, name: rule.name, kind: rule.kind, versions: rule.versions };
  const layer = payments.map(toLayerPayment);
  const typical = usableTypical(forecastRule, layer);
  const inForecast = rule.estimateMode === "VARIES" && typical ? typical : null;
  const heading = [rule.kind === "INCOME" ? "Income" : "Bill", rule.category, rule.paysAccount && `pays ${rule.paysAccount.name}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <h1>{rule.name}</h1>
      <p className="muted">
        {heading}{" "}
        {state === "ended" && <span className="chip chip-muted">Ended</span>}
        {rule.archivedAt && <span className="chip chip-muted">Archived</span>}
      </p>
      {rule.notes && <p>{rule.notes}</p>}

      <h2>Versions</h2>
      <ol className="cards" aria-label="Versions">
        {rule.versions.map((version) => (
          <li key={version.id} className="card">
            <p>
              <strong>
                {formatIsoDate(version.effectiveFrom)} → {version.effectiveTo ? formatIsoDate(version.effectiveTo) : "(no end)"}
              </strong>{" "}
              {today && version.effectiveFrom <= today && (version.effectiveTo === null || version.effectiveTo >= today) && <span className="chip chip-ok">In effect</span>}
            </p>
            <p>{describeVersion(version, nameOf)}</p>
            {version.note && <p className="muted">{version.note}</p>}
            {!rule.archivedAt && (
              <EditVersionForm ruleId={rule.id} kind={rule.kind} version={version} isLatest={version.id === latest.id} accounts={choices} />
            )}
          </li>
        ))}
      </ol>

      {!rule.archivedAt && <Actions rule={rule} today={today} choices={choices} accounts={accounts} />}
      {today && (
        <Estimate
          ruleId={rule.id}
          archived={rule.archivedAt !== null}
          mode={rule.estimateMode}
          planned={versionFor(rule.versions, today).amount}
          typical={typical}
          payments={paymentTotals(forecastRule, layer).length}
        />
      )}
      {today && !rule.archivedAt && (
        <NextOccurrences
          ruleId={rule.id}
          versions={rule.versions}
          today={today}
          overrides={overrides}
          nameOf={nameOf}
          typical={inForecast}
          paid={new Set(payments.flatMap((p) => (p.scheduledOn ? [p.scheduledOn] : [])))}
        />
      )}
      {today && (
        <Payments
          ruleId={rule.id}
          kind={rule.kind}
          rows={paymentHistory(
            forecastRule,
            overrides.map((o) => ({ ...o, ruleId: rule.id })),
            payments,
            addDays(today, -HISTORY_DAYS),
            today,
          )}
        />
      )}
      <EditsOffSchedule ruleId={rule.id} archived={rule.archivedAt !== null} versions={rule.versions} overrides={overrides} />
    </>
  );
}

function describeVersion(version: StoredVersion, nameOf: NameOf): string {
  const splits = describeAllocations(version.allocations.map((a) => ({ ...a, accountName: nameOf(a.accountId) })));
  return `${formatMoney(version.amount, "USD")} · ${describeSchedule(version)} · ${splits}`;
}

function Actions({
  rule,
  today,
  choices,
  accounts,
}: {
  rule: RuleView;
  today: IsoDate | null;
  choices: AccountChoice[];
  accounts: Map<string, { name: string; type: string }>;
}) {
  if (!today) {
    return (
      <section className="notice">
        <p>Choose your household&apos;s time zone to see what&apos;s next and to change this.</p>
        <TimeZoneForm current={null} zones={Intl.supportedValuesOf("timeZone")} />
      </section>
    );
  }
  const names = Object.fromEntries([...accounts].map(([accountId, account]) => [accountId, account.name]));
  return (
    <section className="actions">
      <ChangeFromForm ruleId={rule.id} kind={rule.kind} versions={rule.versions} accounts={choices} names={names} today={today} />
      <StopForm ruleId={rule.id} versions={rule.versions} today={today} />
      <RuleDetailsForm
        ruleId={rule.id}
        kind={rule.kind}
        name={rule.name}
        category={rule.category}
        notes={rule.notes}
        paysAccountId={rule.paysAccount?.id ?? null}
        paysAccountName={rule.paysAccount?.name ?? null}
        cards={choices.filter((account) => account.type === "credit")}
      />
      <ArchiveRuleButton ruleId={rule.id} name={rule.name} />
    </section>
  );
}

/** Where the amount for coming dates comes from, and what the real payments say about it. */
function Estimate({
  ruleId,
  archived,
  mode,
  planned,
  typical,
  payments,
}: {
  ruleId: string;
  archived: boolean;
  mode: "FIXED" | "VARIES";
  planned: string;
  typical: Typical | null;
  payments: number;
}) {
  const plan = formatMoney(planned, "USD");
  const working = typical && (
    <>
      {money(typical.cents)}, the middle of its last {typical.count} payments ({money(typical.low)} to {money(typical.high)})
    </>
  );
  return (
    <section aria-labelledby="estimate-heading">
      <h2 id="estimate-heading">Estimate</h2>
      {mode === "VARIES" ? (
        <p>
          <span className="chip chip-ok">Varies</span>{" "}
          {typical ? (
            <>Coming dates use {working}. The amount you typed, {plan}, is used if there are ever too few payments.</>
          ) : (
            <>
              Coming dates use {plan} for now. Once {TYPICAL_NEEDS} payments are matched ({payments} so far), they use what the
              payments typically were.
            </>
          )}
        </p>
      ) : (
        <p>
          <span className="chip chip-muted">Fixed</span> Coming dates use the amount you typed, {plan}.{" "}
          {typical && differs(toCents(planned), typical.cents) ? (
            <strong>Its payments are typically {working}.</strong>
          ) : typical ? (
            <>Its payments agree: typically {working}.</>
          ) : null}
        </p>
      )}
      {!archived && <EstimateModeForm ruleId={ruleId} mode={mode} />}
    </section>
  );
}

const HISTORY_DAYS = 365;
const HISTORY_SHOWN = 30;

/** The rule's past: each due date with what was planned and what the bank shows, and payments from before it began. */
function Payments({ ruleId, kind, rows }: { ruleId: string; kind: "INCOME" | "BILL"; rows: HistoryRow[] }) {
  if (rows.length === 0) return null;
  const word = kind === "INCOME" ? "Received" : "Paid";
  const shown = rows.slice(0, HISTORY_SHOWN);
  return (
    <>
      <h2>Past</h2>
      <div className="panel panel-flush">
        <table className="table stack" aria-label="Past">
          <thead>
            <tr>
              <th>Due</th>
              <th className="num">{word}</th>
              <th>From the bank</th>
              <th>Against the plan</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.scheduledOn ?? row.payments[0].transactionId}>
                <td className="c-main">
                  {row.scheduledOn ? (
                    <Link href={occurrenceHref(ruleId, row.scheduledOn, `/bills/${ruleId}`)}>{formatIsoDate(row.scheduledOn)}</Link>
                  ) : (
                    <span className="muted">No due date</span>
                  )}
                </td>
                <td className="num c-amt">{row.paid === null ? "—" : money(row.paid)}</td>
                <td className="c-sub">
                  {row.payments.map((p, i) => (
                    <span key={p.transactionId}>
                      {i > 0 && " · "}
                      <Link href={`/transactions/${p.transactionId}`}>{p.payee}</Link>, {formatIsoDate(p.date)}
                      {p.source === "AUTO" && <span className="chip chip-muted">Auto</span>}
                    </span>
                  ))}
                </td>
                <td className="c-sub2">{againstPlan(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length && <p className="muted page-note">Showing the latest {shown.length} of the past year.</p>}
    </>
  );
}

function againstPlan(row: HistoryRow): string {
  if (row.paid === null) {
    if (row.status === "PAID") return "Marked paid by hand";
    if (row.status === "SKIPPED") return "Skipped";
    return `No payment matched (planned ${row.planned === null ? "" : money(row.planned)})`;
  }
  if (row.planned === null) return "From before its first date";
  const gap = row.paid - row.planned;
  return gap === 0n ? "As planned" : `${signedMoney(gap)} against ${money(row.planned)}`;
}

function NextOccurrences({
  ruleId,
  versions,
  today,
  overrides,
  nameOf,
  typical,
  paid,
}: {
  ruleId: string;
  versions: StoredVersion[];
  today: IsoDate;
  overrides: OverrideView[];
  nameOf: NameOf;
  /** Set for a rule that varies: the amount coming dates use unless one is confirmed. */
  typical: Typical | null;
  /** Due dates the bank already shows paid. */
  paid: ReadonlySet<IsoDate>;
}) {
  const edits = new Map(overrides.map((edit) => [edit.scheduledOn, edit]));
  const upcoming = nextOccurrences(versions, today, 10);
  if (upcoming.length === 0) {
    return (
      <>
        <h2>Next 10</h2>
        <p className="muted">Nothing more is scheduled.</p>
      </>
    );
  }
  return (
    <>
      <h2>Next 10</h2>
      <div className="panel panel-flush">
        <table className="table stack" aria-label="Next 10">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Amount</th>
              <th>Accounts</th>
              <th>Status</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {upcoming.map(({ date, version }) => {
              const edit = edits.get(date);
              const amount = edit?.confirmedAmount ?? (typical ? fromCents(typical.cents) : version.amount);
              const shares = splitAmount(toCents(amount), version.allocations)
                .map((share) => `${nameOf(share.accountId)} ${formatMoney(fromCents(share.cents), "USD")}`)
                .join(" · ");
              return (
                <tr key={date}>
                  <td className="c-main">
                    <Link href={occurrenceHref(ruleId, date, `/bills/${ruleId}`)}>{formatIsoDate(date)}</Link>
                    {edit?.movedTo && <span className="muted"> (moved to {formatIsoDate(edit.movedTo)})</span>}
                  </td>
                  <td className="num c-amt">{formatMoney(amount, "USD")}</td>
                  <td className="c-sub">{shares}</td>
                  <td className="c-side">{paid.has(date) ? "Paid (see Past)" : STATUS_LABELS[edit?.status ?? "PLANNED"]}</td>
                  <td className="c-note">{edit?.note ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Per-date edits whose date the rule no longer produces: kept and shown, never deleted silently. */
function EditsOffSchedule({ ruleId, archived, versions, overrides }: { ruleId: string; archived: boolean; versions: StoredVersion[]; overrides: OverrideView[] }) {
  const orphans = overrides.filter((edit) => ruleOccurrences(versions, edit.scheduledOn, edit.scheduledOn).length === 0);
  if (orphans.length === 0) return null;
  return (
    <section className="notice notice-warn">
      <h2>Edits on dates this no longer produces</h2>
      <p>These were made for dates the schedule no longer has. They are kept, not deleted.</p>
      <ul>
        {orphans.map((edit) => (
          <li key={edit.scheduledOn}>
            {formatIsoDate(edit.scheduledOn)}: {STATUS_LABELS[edit.status]}
            {edit.note ? ` (${edit.note})` : ""}{" "}
            {!archived && <Link href={occurrenceHref(ruleId, edit.scheduledOn, `/bills/${ruleId}`)}>Review it</Link>}
          </li>
        ))}
      </ul>
    </section>
  );
}
