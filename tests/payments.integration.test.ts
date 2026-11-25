import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { setHouseholdTimeZone } from "@/features/accounts/manual";
import { buildForecast, type AccountSeries } from "@/features/forecast/engine";
import { loadForecastInput } from "@/features/forecast/queries";
import { listMatchQuestions, listPayments } from "@/features/payments/queries";
import { confirmMatch, declineMatch, PaymentInputError, runMatching, undoMatch } from "@/features/payments/service";
import { createRuleInput } from "@/features/rules/input";
import { createRule } from "@/features/rules/service";
import { seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

// Everything here is made up: a household, one bank-attached checking account,
// an electricity bill due on the 10th, and a few bank transactions.

const { ownerUrl, appUrl } = inject("testDatabase");
const NY = "America/New_York";
const NOW = new Date("2026-12-14T17:00:00Z"); // Dec 14 in New York
const SCOPE = { environment: "SANDBOX" as const, now: NOW };
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

let owner: PrismaClient;
let app: PrismaClient;
let householdId: string;
let userId: string;
let itemId: string;
let spend: string;
let electric: string;
let serial = 0;

beforeAll(() => {
  owner = createTestClient(ownerUrl);
  app = createTestClient(appUrl);
});
afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});

async function attachedAccount(home: string, item: string, name: string) {
  const account = await owner.account.create({
    data: { householdId: home, plaidItemId: item, externalAccountId: `ext-${name}`, attachedAt: NOW, name, type: "depository", subtype: "checking", currency: "USD" },
  });
  return account.id;
}

async function bankTransaction(patch: { date: string; amount: string; description: string; accountId?: string; pending?: boolean; item?: string }) {
  const row = await owner.transaction.create({
    data: {
      accountId: patch.accountId ?? spend,
      plaidItemId: patch.item ?? itemId,
      providerTransactionId: `tx-${++serial}`,
      amount: patch.amount,
      currency: "USD",
      date: d(patch.date),
      pending: patch.pending ?? false,
      description: patch.description,
    },
  });
  return row.id;
}

const bill = (name: string, amount: string, anchorDate: string, accountId = spend, home = householdId) =>
  createRule(
    app,
    home,
    createRuleInput.parse({
      kind: "BILL",
      name,
      amount,
      schedule: { recurrence: "MONTHLY", interval: 1, anchorDate, dayOfMonth: Number(anchorDate.slice(8)) },
      allocations: [{ accountId, mode: "REMAINDER" }],
    }),
  ).then((rule) => rule.id);

beforeEach(async () => {
  await truncateAll(owner);
  ({ householdId, userId } = await seedPerson(owner, "owner@example.test"));
  await setHouseholdTimeZone(app, householdId, NY);
  itemId = (await owner.plaidItem.create({ data: { householdId, environment: "SANDBOX", plaidItemId: "item-1", status: "ACTIVE" } })).id;
  spend = await attachedAccount(householdId, itemId, "Spend");
  await owner.balanceSnapshot.create({
    data: { accountId: spend, observedAt: NOW, current: "2000", currency: "USD", source: "ACCOUNTS_GET" },
  });
  electric = await bill("Electric", "100", "2026-11-10");
});

const questions = () => listMatchQuestions(app, householdId, { environment: "SANDBOX", today: "2026-12-14", since: "2026-09-01" });
const confirm = (transactionId: string, scheduledOn: string | null, ruleId = electric, home = householdId) =>
  confirmMatch(app, home, userId, transactionId, { ruleId, scheduledOn }, SCOPE);
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof PaymentInputError ? error.code : "threw"),
  );
const series = async () => {
  const input = await loadForecastInput(app, householdId, { environment: "SANDBOX", timeZone: NY, today: "2026-12-14" });
  return { input, spend: buildForecast(input).accounts.find((a) => a.account.id === spend) as AccountSeries };
};

describe("matching bank transactions to bills", () => {
  it("asks first, then links the same payee by itself once the person has said yes", async () => {
    const november = await bankTransaction({ date: "2026-11-09", amount: "104.10", description: "CITY ELECTRIC 5521 WEB PMT" });
    expect(await runMatching(app, householdId, SCOPE)).toEqual({ linked: 0 });
    expect(await questions()).toMatchObject([
      { transactionId: november, ruleId: electric, ruleName: "Electric", scheduledOn: "2026-11-10", cents: 10410n, accountName: "Spend" },
    ]);

    // Two more from the same payee: one before the bill existed, one for December.
    const october = await bankTransaction({ date: "2026-10-08", amount: "97", description: "CITY ELECTRIC 5433 WEB PMT" });
    const december = await bankTransaction({ date: "2026-12-11", amount: "111.25", description: "CITY ELECTRIC 5610 WEB PMT" });
    await confirm(november, "2026-11-10");

    const payments = await listPayments(app, householdId, SCOPE);
    expect(payments.map((p) => [p.transactionId, p.scheduledOn, p.source])).toEqual([
      [october, null, "AUTO"],
      [november, "2026-11-10", "PERSON"],
      [december, "2026-12-10", "AUTO"],
    ]);
    expect(await questions()).toEqual([]);
    expect(await runMatching(app, householdId, SCOPE)).toEqual({ linked: 0 });
  });

  it("makes the forecast read a matched date as Paid, for the real amount on the real day, and undo puts it back", async () => {
    expect((await series()).spend.days[0]).toMatchObject({ date: "2026-12-14", closing: 200000n });
    const occurrence = () => series().then((s) => buildForecast(s.input).occurrences.find((o) => o.ruleId === electric && o.scheduledOn === "2026-12-10"));
    expect(await occurrence()).toMatchObject({ status: "PLANNED", estimate: true, amount: 10000n, date: "2026-12-10" });

    const paid = await bankTransaction({ date: "2026-12-11", amount: "111.25", description: "CITY ELECTRIC 5610 WEB PMT" });
    await owner.occurrenceOverride.create({ data: { householdId, ruleId: electric, scheduledOn: d("2026-12-10"), status: "CONFIRMED", confirmedAmount: "105", note: "mine" } });
    await confirm(paid, "2026-12-10");
    expect(await occurrence()).toMatchObject({ status: "PAID", estimate: false, amount: 11125n, date: "2026-12-11" });
    // The person's own edit is untouched underneath.
    expect(await owner.occurrenceOverride.findFirstOrThrow({ where: { ruleId: electric } })).toMatchObject({ status: "CONFIRMED", note: "mine" });

    await undoMatch(app, householdId, paid);
    expect(await occurrence()).toMatchObject({ status: "CONFIRMED", estimate: false, amount: 10500n, date: "2026-12-10" });
    // Undone means declined: it is not proposed or linked again.
    expect(await questions()).toEqual([]);
    expect(await runMatching(app, householdId, SCOPE)).toEqual({ linked: 0 });
    // The person can still put it back by hand.
    await confirm(paid, "2026-12-10");
    expect(await owner.matchDecline.count()).toBe(0);
  });

  it("stops an early payment counting twice", async () => {
    // January's bill is paid on Dec 12, before the Dec 14 balance: the forecast must not take it again in January.
    const early = await bankTransaction({ date: "2026-12-12", amount: "100", description: "CITY ELECTRIC 5700 WEB PMT" });
    const january = (s: AccountSeries) => s.days.find((day) => day.date === "2027-01-10");
    expect(january((await series()).spend)?.items).toHaveLength(1);
    await confirm(early, "2027-01-10");
    expect(january((await series()).spend)?.items).toEqual([]);
  });

  it("uses what a bill is typically paid once it is set to vary", async () => {
    for (const [date, amount] of [["2026-08-10", "120"], ["2026-09-10", "140"], ["2026-10-09", "131.50"]]) {
      await confirm(await bankTransaction({ date, amount, description: "CITY ELECTRIC WEB PMT" }), null);
    }
    const next = async () => (await series()).spend.days.find((day) => day.date === "2027-01-10")?.items[0];
    expect(await next()).toMatchObject({ cents: -10000n });
    await owner.rule.update({ where: { id: electric }, data: { estimateMode: "VARIES" } });
    expect(await next()).toMatchObject({ cents: -13150n, occurrence: { estimate: true } });
  });

  it("No is remembered for that pair, and that payee is never again linked to the bill without asking", async () => {
    const first = await bankTransaction({ date: "2026-11-09", amount: "100", description: "CITY ELECTRIC WEB PMT" });
    await confirm(first, "2026-11-10");
    const odd = await bankTransaction({ date: "2026-12-09", amount: "100", description: "CITY ELECTRIC WEB PMT" });
    expect(await runMatching(app, householdId, SCOPE)).toEqual({ linked: 1 });
    await undoMatch(app, householdId, odd);
    const later = await bankTransaction({ date: "2027-01-09", amount: "100", description: "CITY ELECTRIC WEB PMT" });
    expect(await runMatching(app, householdId, SCOPE)).toEqual({ linked: 0 });
    expect((await questions()).map((q) => q.transactionId)).toEqual([later]);
    await declineMatch(app, householdId, later, electric);
    expect(await questions()).toEqual([]);
  });

  it("refuses what cannot be a payment of that bill", async () => {
    const other = await seedPerson(owner, "other@example.test");
    const theirItem = (await owner.plaidItem.create({ data: { householdId: other.householdId, environment: "SANDBOX", plaidItemId: "item-2", status: "ACTIVE" } })).id;
    const theirAccount = await attachedAccount(other.householdId, theirItem, "Theirs");
    const theirs = await bankTransaction({ date: "2026-12-10", amount: "100", description: "CITY ELECTRIC", accountId: theirAccount, item: theirItem });
    const theirBill = await bill("Their electric", "100", "2026-11-10", theirAccount, other.householdId);
    const savings = await attachedAccount(householdId, itemId, "Savings");

    const mine = await bankTransaction({ date: "2026-12-10", amount: "100", description: "CITY ELECTRIC" });
    expect(await code(confirm(theirs, "2026-12-10"))).toBe("transaction_not_found");
    expect(await code(confirm(mine, "2026-12-10", theirBill))).toBe("rule_not_found");
    expect(await code(confirm(mine, "2026-12-11"))).toBe("occurrence_not_found");
    expect(await code(confirm(await bankTransaction({ date: "2026-12-10", amount: "-100", description: "REFUND" }), "2026-12-10"))).toBe("wrong_direction");
    expect(await code(confirm(await bankTransaction({ date: "2026-12-10", amount: "100", description: "X", accountId: savings }), "2026-12-10"))).toBe("wrong_account");
    expect(await code(confirm(await bankTransaction({ date: "2026-12-10", amount: "100", description: "X", pending: true }), "2026-12-10"))).toBe("transaction_not_found");
    expect(await code(undoMatch(app, householdId, mine))).toBe("not_matched");
    expect(await code(declineMatch(app, householdId, theirs, electric))).toBe("transaction_not_found");
    expect(await code(declineMatch(app, other.householdId, mine, electric))).toBe("rule_not_found");

    await confirm(mine, "2026-12-10");
    expect(await code(confirm(mine, "2026-12-10"))).toBe("already_matched");
    expect(await code(undoMatch(app, other.householdId, mine))).toBe("not_matched");
    await owner.rule.update({ where: { id: electric }, data: { archivedAt: NOW } });
    expect(await code(confirm(await bankTransaction({ date: "2026-12-10", amount: "100", description: "Y" }), "2026-12-10"))).toBe("rule_archived");
    expect(await owner.payment.count()).toBe(1);
  });

  it("loses a transaction's match when the transaction itself is deleted", async () => {
    const paid = await bankTransaction({ date: "2026-12-10", amount: "100", description: "CITY ELECTRIC" });
    await confirm(paid, "2026-12-10");
    await owner.transaction.delete({ where: { id: paid } });
    expect(await owner.payment.count()).toBe(0);
  });
});
