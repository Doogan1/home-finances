import { createAccountInput, type AccountKind } from "@/features/accounts/input";
import { clampedDay, firstOnOrAfter, type Pattern } from "@/features/rules/recurrence";
import type { AllocationMode } from "@/features/rules/splits";
import { allocationProblem, planChangeFrom, scheduleProblem, type RuleKind, type StoredVersion } from "@/features/rules/versions";
import type { IsoDate } from "@/lib/calendar-date";
import { toCents } from "@/lib/cents";
import type { Choices } from "./choices";
import type { AccountType, ParsedWorkbook, Settings, WorkbookAccount, WorkbookBill } from "./parse";
import { compareSchedule } from "./schedule";

/**
 * What the import would create, from the parsed workbook and the person's
 * answers. Pure: the dry run prints it, the checks run the forecast on it,
 * and `--apply` writes exactly it. Anything the workbook cannot decide is a
 * question; anything that cannot be imported as it stands is a problem. Both
 * block `--apply`; notes do not.
 */

/** The workbook Account IDs the Settings pay rows split into. */
export const LAYOUT = {
  spend: "ASPEND",
  savings: "ASAV",
  pnc: "DPNC",
  personal: "ALEXCHK",
  drake: { ref: "PAY-DRAKE", name: "Drake pay" },
  alexis: { ref: "PAY-ALEXIS", name: "Alexis pay" },
} as const;

export type PlannedAccount = { ref: string; name: string; kind: AccountKind; ownerLabel: string | null; cushion: string | null };
export type PlannedSnapshot = { accountRef: string; asOfDate: IsoDate; balance: string };
export type PlannedAllocation = { accountRef: string; mode: AllocationMode; value: string | null };
export type PlannedVersion = Pattern & {
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  amount: string;
  note: string | null;
  allocations: PlannedAllocation[];
};
export type PlannedRule = {
  ref: string;
  name: string;
  kind: RuleKind;
  category: string | null;
  notes: string | null;
  paysAccountRef: string | null;
  /** A bill paid directly, so the Bill Schedule should have its dates. */
  scheduled: boolean;
  versions: PlannedVersion[];
};
export type PlannedOverride = { ruleRef: string; scheduledOn: IsoDate; status: "SKIPPED" | "CONFIRMED"; confirmedAmount: string | null };
export type Question = { section: "cards" | "pays" | "schedule"; key: string; prompt: string; options: string[] };
export type ImportPlan = {
  forecastStart: IsoDate | null;
  accounts: PlannedAccount[];
  snapshots: PlannedSnapshot[];
  rules: PlannedRule[];
  overrides: PlannedOverride[];
  questions: Question[];
  problems: string[];
  notes: string[];
};

const KINDS: Record<AccountType, AccountKind> = { Checking: "checking", Savings: "savings", "Credit card": "credit_card" };
const nameKey = (name: string) => name.toLowerCase();

function planAccounts(workbook: ParsedWorkbook, settings: Settings, problems: string[]): PlannedAccount[] {
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const accounts: PlannedAccount[] = [];
  for (const a of workbook.accounts) {
    if (seenIds.has(a.id)) problems.push(`Accounts row ${a.row}: Account ID ${a.id} appears twice`);
    if (seenNames.has(nameKey(a.name))) problems.push(`Accounts row ${a.row}: the name "${a.name}" appears twice`);
    seenIds.add(a.id);
    seenNames.add(nameKey(a.name));
    const cushion = a.id === LAYOUT.spend ? settings.cushion : null;
    const parsed = createAccountInput.safeParse({
      name: a.name,
      kind: KINDS[a.type],
      ownerLabel: a.owner ?? undefined,
      cushion: cushion ?? undefined,
    });
    if (!parsed.success) {
      problems.push(`Accounts row ${a.row}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      continue;
    }
    accounts.push({ ref: a.id, name: parsed.data.name, kind: parsed.data.kind, ownerLabel: parsed.data.ownerLabel, cushion: parsed.data.cushion });
  }
  for (const [what, ref] of [["Ally Spend", LAYOUT.spend], ["Ally Savings", LAYOUT.savings], ["PNC", LAYOUT.pnc], ["personal", LAYOUT.personal]]) {
    const account = accounts.find((a) => a.ref === ref);
    if (!account) problems.push(`Accounts: the pay split needs a ${what} account with Account ID ${ref}`);
    else if (account.kind === "credit_card") problems.push(`Accounts: ${ref} must be a checking or savings account`);
  }
  return accounts;
}

/**
 * One balance per account and date. Candidates are taken in this order:
 * Balance History rows top to bottom, then the Accounts sheet's latest
 * balance; on the same account and date the later one is newest and wins.
 */
function planSnapshots(workbook: ParsedWorkbook, accounts: readonly PlannedAccount[], today: IsoDate | null, problems: string[], notes: string[]) {
  const refs = new Set(accounts.map((a) => a.ref));
  type Candidate = PlannedSnapshot & { from: string };
  const candidates: Candidate[] = [
    ...workbook.history.map((h) => ({ accountRef: h.accountId, asOfDate: h.asOfDate, balance: h.balance, from: `Balance History row ${h.row}` })),
    ...workbook.accounts.flatMap((a: WorkbookAccount) =>
      a.balance !== null && a.balanceDate !== null
        ? [{ accountRef: a.id, asOfDate: a.balanceDate, balance: a.balance, from: `Accounts row ${a.row}` }]
        : [],
    ),
  ];
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!refs.has(c.accountRef)) {
      problems.push(`${c.from}: Account ID ${c.accountRef} is not in the Accounts sheet`);
      continue;
    }
    if (today !== null && c.asOfDate > today) {
      problems.push(`${c.from}: the balance is dated ${c.asOfDate}, after today (${today})`);
      continue;
    }
    const key = `${c.accountRef}|${c.asOfDate}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const snapshots: PlannedSnapshot[] = [];
  for (const group of groups.values()) {
    const kept = group[group.length - 1];
    snapshots.push({ accountRef: kept.accountRef, asOfDate: kept.asOfDate, balance: kept.balance });
    if (group.length > 1) {
      const others = group.slice(0, -1).map((c) => `${c.from} (${c.balance})`).join(", ");
      const same = group.every((c) => toCents(c.balance) === toCents(kept.balance));
      notes.push(
        `${kept.accountRef} on ${kept.asOfDate}: ${group.length} balances merged; kept ${kept.balance} from ${kept.from}, the newest; ` +
          `${same ? "the same value in" : "replacing"} ${others}`,
      );
    }
  }
  return snapshots.sort((a, b) => a.accountRef.localeCompare(b.accountRef) || a.asOfDate.localeCompare(b.asOfDate));
}

const typeOf = (accounts: readonly PlannedAccount[], ref: string) =>
  accounts.find((a) => a.ref === ref)?.kind === "credit_card" ? "credit" : "depository";

function checkVersion(kind: RuleKind, version: PlannedVersion, accounts: readonly PlannedAccount[], where: string, problems: string[]) {
  const schedule = scheduleProblem(version, version.effectiveFrom);
  const allocation = allocationProblem(
    kind,
    version.amount,
    version.allocations.map((a) => ({ accountId: a.accountRef, mode: a.mode, value: a.value, accountType: typeOf(accounts, a.accountRef) })),
  );
  if (toCents(version.amount) <= 0n) problems.push(`${where}: the amount must be more than zero`);
  else if (schedule ?? allocation) problems.push(`${where}: ${schedule ?? allocation}`);
}

function checkText(rule: PlannedRule, where: string, problems: string[]) {
  if (rule.name.length > 80) problems.push(`${where}: the name is longer than 80 characters`);
  if ((rule.category?.length ?? 0) > 40) problems.push(`${where}: the category is longer than 40 characters`);
  if ((rule.notes?.length ?? 0) > 500) problems.push(`${where}: the notes are longer than 500 characters`);
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** The card a card-payment bill most likely pays: the same id, else the longest shared start (at least 3 letters). */
function suggestCard(billId: string, cardIds: readonly string[]): string | null {
  if (cardIds.includes(billId)) return billId;
  const best = [...cardIds].sort((a, b) => commonPrefix(billId, b) - commonPrefix(billId, a))[0];
  return best !== undefined && commonPrefix(billId, best) >= 3 ? best : null;
}

function billPattern(bill: WorkbookBill, first: IsoDate | undefined, start: IsoDate): Pattern {
  if (bill.frequency === "Weekly") {
    return { recurrence: "WEEKLY", interval: 1, anchorDate: first ?? start, dayOfMonth: null, secondDay: null };
  }
  const interval = bill.frequency === "Semiannual" ? 6 : 1;
  const base = first ?? start;
  const day = bill.dueDay ?? Number(base.slice(8, 10));
  const pattern: Pattern = {
    recurrence: "MONTHLY",
    interval,
    anchorDate: clampedDay(Number(base.slice(0, 4)), Number(base.slice(5, 7)), day),
    dayOfMonth: day,
    secondDay: null,
  };
  // The due day can fall before the first schedule date (or the forecast start) in that month.
  return { ...pattern, anchorDate: firstOnOrAfter(pattern, start) ?? pattern.anchorDate };
}

function planBills(
  workbook: ParsedWorkbook,
  accounts: readonly PlannedAccount[],
  choices: Choices,
  start: IsoDate,
  out: { questions: Question[]; problems: string[]; notes: string[] },
): PlannedRule[] {
  const byName = new Map(accounts.map((a) => [nameKey(a.name), a]));
  const cardIds = accounts.filter((a) => a.kind === "credit_card").map((a) => a.ref);
  const seen = new Set<string>();
  const rules: PlannedRule[] = [];
  for (const bill of workbook.bills) {
    const where = `Bills row ${bill.row} (${bill.id})`;
    if (seen.has(bill.id)) {
      out.problems.push(`${where}: Bill ID ${bill.id} appears twice`);
      continue;
    }
    seen.add(bill.id);
    const direct = bill.treatment === "Direct";

    let accountRef: string | null = null;
    if (direct) {
      const account = bill.paymentAccount === null ? undefined : byName.get(nameKey(bill.paymentAccount));
      if (account) accountRef = account.ref;
      else out.problems.push(`${where}: the payment account "${bill.paymentAccount ?? ""}" is not an account name in the Accounts sheet`);
    } else {
      const answer = choices.cards[bill.id];
      if (answer === undefined) {
        out.questions.push({
          section: "cards",
          key: bill.id,
          prompt: `${bill.name} (${bill.amount}, ${bill.frequency}) is included in a card payment: which card is it charged to?`,
          options: cardIds,
        });
      } else if (cardIds.includes(answer)) accountRef = answer;
      else out.problems.push(`choices.json cards.${bill.id}: ${answer} is not a credit card Account ID (${cardIds.join(", ")})`);
    }

    let paysAccountRef: string | null = null;
    const looksLikeCardPayment = direct && (cardIds.includes(bill.id) || /card/i.test(`${bill.id} ${bill.name}`));
    if (Object.hasOwn(choices.pays, bill.id)) {
      const answer = choices.pays[bill.id];
      if (!direct) out.problems.push(`choices.json pays.${bill.id}: only a bill paid directly can pay a card`);
      else if (answer !== null && !cardIds.includes(answer)) {
        out.problems.push(`choices.json pays.${bill.id}: ${answer} is not a credit card Account ID (${cardIds.join(", ")})`);
      } else paysAccountRef = answer;
    } else if (looksLikeCardPayment) {
      const suggestion = suggestCard(bill.id, cardIds);
      out.questions.push({
        section: "pays",
        key: bill.id,
        prompt: `${bill.name} looks like a card payment: which card does it pay (null if none)?${suggestion ? ` Suggested: ${suggestion}` : ""}`,
        options: [...cardIds, "null"],
      });
    }

    const first = workbook.schedule
      .filter((entry) => entry.billId === bill.id && entry.dueDate >= start)
      .map((entry) => entry.dueDate)
      .sort()[0];
    if (first === undefined) out.notes.push(`${bill.id}: no Bill Schedule date to anchor on; anchored from the forecast start`);
    const notes = [bill.method ? `Method: ${bill.method}` : null, bill.notes].filter((n) => n !== null).join("; ") || null;
    const rule: PlannedRule = {
      ref: bill.id,
      name: bill.name,
      kind: "BILL",
      category: bill.category,
      notes,
      paysAccountRef,
      scheduled: direct,
      versions: [
        {
          ...billPattern(bill, first, start),
          effectiveFrom: start,
          effectiveTo: null,
          amount: bill.amount,
          note: null,
          allocations: accountRef === null ? [] : [{ accountRef, mode: "REMAINDER", value: null }],
        },
      ],
    };
    checkText(rule, where, out.problems);
    if (accountRef !== null) checkVersion("BILL", rule.versions[0], accounts, where, out.problems);
    rules.push(rule);
  }
  return rules;
}

const percentAllocation = (accountRef: string, share: string): PlannedAllocation[] =>
  toCents(share) === 0n ? [] : [{ accountRef, mode: "PERCENT", value: share }];

function incomeRule(
  layout: { ref: string; name: string },
  pattern: Pattern,
  pay: { net: string; shares: [string, string][]; savingsShare: string | null; changeFrom: IsoDate | null; changedNet: string | null; notes: string | null },
  start: IsoDate,
  accounts: readonly PlannedAccount[],
  out: { problems: string[]; notes: string[] },
): PlannedRule {
  const where = `Settings (${layout.name})`;
  const allocations = [
    ...pay.shares.flatMap(([ref, share]) => percentAllocation(ref, share)),
    { accountRef: LAYOUT.savings, mode: "REMAINDER" as const, value: null },
  ];
  const first: PlannedVersion = { ...pattern, effectiveFrom: start, effectiveTo: null, amount: pay.net, note: null, allocations };
  checkVersion("INCOME", first, accounts, where, out.problems);

  const given = pay.shares.reduce((sum, [, share]) => sum + toCents(share), 0n);
  if (pay.savingsShare !== null && given + toCents(pay.savingsShare) !== 10000n) {
    out.notes.push(
      `${layout.name}: the shares add up to ${Number(given + toCents(pay.savingsShare)) / 100}%; ` +
        `savings takes the rest (${Number(10000n - given) / 100}%)`,
    );
  }

  const versions = [first];
  if ((pay.changeFrom === null) !== (pay.changedNet === null)) {
    out.problems.push(`${where}: a pay change needs both its date and its new amount`);
  } else if (pay.changeFrom !== null && pay.changedNet !== null) {
    const stored: StoredVersion = { ...first, id: "v1", allocations: allocations.map((a) => ({ accountId: a.accountRef, mode: a.mode, value: a.value })) };
    const change = planChangeFrom([stored], { from: pay.changeFrom, amount: pay.changedNet, note: null, allocations: stored.allocations, schedule: null });
    if (!change.ok) out.problems.push(`${where}: the pay change on ${pay.changeFrom} cannot be made (${change.code})`);
    else {
      first.effectiveTo = change.value.endOn;
      const { next } = change.value;
      versions.push({ ...next, allocations });
      checkVersion("INCOME", versions[1], accounts, `${where}, changed pay`, out.problems);
    }
  }
  return { ref: layout.ref, name: layout.name, kind: "INCOME", category: null, notes: pay.notes, paysAccountRef: null, scheduled: false, versions };
}

function planIncome(settings: Settings, accounts: readonly PlannedAccount[], out: { problems: string[]; notes: string[] }): PlannedRule[] {
  const start = settings.forecastStart;
  const { drake, alexis } = settings;
  const weekly: Pattern = { recurrence: "WEEKLY", interval: 1, anchorDate: drake.firstPayday, dayOfMonth: null, secondDay: null };
  const rules = [
    incomeRule(
      LAYOUT.drake,
      // A first payday before the forecast start moves on by whole weeks.
      { ...weekly, anchorDate: firstOnOrAfter(weekly, start) ?? drake.firstPayday },
      {
        net: drake.weeklyNet,
        shares: [[LAYOUT.spend, drake.spendShare], [LAYOUT.pnc, drake.pncShare]],
        savingsShare: drake.savingsShare,
        changeFrom: drake.changeFrom,
        changedNet: drake.changedNet,
        notes: drake.notes,
      },
      start,
      accounts,
      out,
    ),
  ];
  const [low, high] = [Math.min(alexis.payDay1, alexis.payDay2), Math.max(alexis.payDay1, alexis.payDay2)];
  if (low === high || low > 27) {
    out.problems.push(`Settings (${LAYOUT.alexis.name}): the two pay days must differ and the first must be the 27th or earlier`);
    return rules;
  }
  const twice: Pattern = { recurrence: "TWICE_MONTHLY", interval: 1, anchorDate: start, dayOfMonth: low, secondDay: high };
  rules.push(
    incomeRule(
      LAYOUT.alexis,
      { ...twice, anchorDate: firstOnOrAfter(twice, start) ?? start },
      {
        net: alexis.semiMonthlyNet,
        shares: [[LAYOUT.spend, alexis.spendShare], [LAYOUT.personal, alexis.personalShare]],
        savingsShare: alexis.savingsShare,
        changeFrom: alexis.changeFrom,
        changedNet: alexis.changedNet,
        notes: alexis.notes,
      },
      start,
      accounts,
      out,
    ),
  );
  return rules;
}

function planOverrides(workbook: ParsedWorkbook, rules: readonly PlannedRule[], choices: Choices, start: IsoDate, out: { questions: Question[]; problems: string[] }) {
  const differences = compareSchedule(rules, workbook.schedule, start).amounts;
  const asked = new Set(differences.map((d) => d.entry.id));
  for (const key of Object.keys(choices.schedule)) {
    if (!asked.has(key)) out.problems.push(`choices.json schedule.${key}: not a Bill Schedule row whose amount differs from its bill`);
  }
  const overrides: PlannedOverride[] = [];
  for (const { entry, ruleRef, ruleAmount } of differences) {
    const answer = choices.schedule[entry.id];
    if (answer === undefined) {
      out.questions.push({
        section: "schedule",
        key: entry.id,
        prompt: `${entry.id}: the schedule has ${entry.expected} on ${entry.dueDate}, the bill ${ruleAmount}. Skip that occurrence, confirm the schedule's amount, or use the rule's?`,
        options: ["skip", "confirm", "rule"],
      });
    } else if (answer === "skip") {
      overrides.push({ ruleRef, scheduledOn: entry.dueDate, status: "SKIPPED", confirmedAmount: null });
    } else if (answer === "confirm") {
      if (toCents(entry.expected) <= 0n) out.problems.push(`choices.json schedule.${entry.id}: ${entry.expected} cannot be confirmed; skip it or use the rule's amount`);
      else overrides.push({ ruleRef, scheduledOn: entry.dueDate, status: "CONFIRMED", confirmedAmount: entry.expected });
    }
  }
  return overrides;
}

function unusedAnswers(workbook: ParsedWorkbook, choices: Choices, problems: string[]) {
  const included = new Set(workbook.bills.filter((b) => b.treatment !== "Direct").map((b) => b.id));
  const bills = new Set(workbook.bills.map((b) => b.id));
  for (const key of Object.keys(choices.cards)) {
    if (!included.has(key)) problems.push(`choices.json cards.${key}: not a bill that is included in a card payment`);
  }
  for (const key of Object.keys(choices.pays)) {
    if (!bills.has(key)) problems.push(`choices.json pays.${key}: not a Bill ID`);
  }
}

/**
 * `today` is the date the command runs; a balance dated after it is a problem. A balance
 * dated after the forecast start is normal (the workbook's latest balances usually are) and
 * is kept: the forecast counts only what is dated after a balance's date, as the Cash Flow
 * sheet does. Null skips the check.
 */
export function planImport(workbook: ParsedWorkbook, choices: Choices, today: IsoDate | null = null): ImportPlan {
  const out = { questions: [] as Question[], problems: [...workbook.problems], notes: [] as string[] };
  const empty = { accounts: [], snapshots: [], rules: [], overrides: [] };
  const { settings } = workbook;
  if (settings === null) return { forecastStart: null, ...empty, ...out };
  const start = settings.forecastStart;

  const accounts = planAccounts(workbook, settings, out.problems);
  const snapshots = planSnapshots(workbook, accounts, today, out.problems, out.notes);
  const income = planIncome(settings, accounts, out);
  const bills = planBills(workbook, accounts, choices, start, out);
  for (const bill of bills) {
    if (income.some((rule) => rule.ref === bill.ref)) out.problems.push(`Bills: Bill ID ${bill.ref} is reserved for pay`);
  }
  const rules = [...income, ...bills];
  unusedAnswers(workbook, choices, out.problems);
  const overrides = planOverrides(workbook, rules, choices, start, out);
  return { forecastStart: start, accounts, snapshots, rules, overrides, ...out };
}
