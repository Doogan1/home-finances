import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { Account, PlaidItem, PrismaClient } from "@/generated/prisma/client";
import { attachBankAccount } from "@/features/accounts/attach";
import { recordBalancesInput } from "@/features/accounts/input";
import { AccountInputError, archiveManualAccount, createManualAccount, recordBalances, setHouseholdTimeZone } from "@/features/accounts/manual";
import { loadForecastInput } from "@/features/forecast/queries";
import { refreshItemAccounts } from "@/features/plaid/accounts";
import { disconnectConnection } from "@/features/plaid/lifecycle";
import { syncItem } from "@/features/plaid/sync";
import { createRuleInput } from "@/features/rules/input";
import { createRule } from "@/features/rules/service";
import { account, accountsGetResponse, createFakePlaidApi, syncPage, txn } from "./helpers/fake-plaid";
import { makeDeps, seedConnection, seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

// Attaching an account from a connected bank to a hand-entered one, against the
// throwaway database with a fake Plaid SDK. Every value is synthetic.

const { ownerUrl, appUrl } = inject("testDatabase");
const NY = "America/New_York";
const NOW = new Date("2026-11-20T17:00:00Z");
const CHECKING = "item_synthetic_1_checking";
const SAVINGS = "item_synthetic_1_savings";

let owner: PrismaClient;
let app: PrismaClient;
let api: ReturnType<typeof createFakePlaidApi>;
let householdId: string;
let item: PlaidItem;
let checking: Account;
let savings: Account;
let spend: string;

beforeAll(() => {
  owner = createTestClient(ownerUrl);
  app = createTestClient(appUrl);
});
afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});
beforeEach(async () => {
  await truncateAll(owner);
  api = createFakePlaidApi();
  ({ householdId } = await seedPerson(owner, "owner@example.test"));
  await setHouseholdTimeZone(app, householdId, NY);
  item = await seedConnection(owner, householdId);
  checking = await owner.account.findFirstOrThrow({ where: { plaidItemId: item.id, externalAccountId: CHECKING } });
  savings = await owner.account.findFirstOrThrow({ where: { plaidItemId: item.id, externalAccountId: SAVINGS } });
  spend = (await createManualAccount(app, householdId, { name: "Ally Spend", kind: "checking", ownerLabel: "Shared", cushion: "500" })).id;
  await recordBalances(
    app,
    householdId,
    recordBalancesInput.parse({ asOfDate: "2026-11-10", entries: [{ accountId: spend, balance: "321" }] }),
    new Date("2026-11-10T18:00:00Z"),
  );
  await owner.transaction.create({
    data: {
      accountId: checking.id,
      plaidItemId: item.id,
      providerTransactionId: "txn_synthetic_1",
      amount: "12.34",
      currency: "USD",
      date: new Date("2026-11-15T00:00:00Z"),
      description: "Synthetic purchase",
    },
  });
});

const deps = () => makeDeps(app, api, { now: () => NOW });
const attach = (target: string, bank: string, home: string = householdId) =>
  attachBankAccount(app, home, target, { plaidAccountId: bank }, { environment: "SANDBOX", now: NOW });
const bill = (accountId: string, name = "Synthetic rent") =>
  createRuleInput.parse({
    kind: "BILL",
    name,
    amount: "700",
    schedule: { recurrence: "MONTHLY", interval: 1, anchorDate: "2026-12-01", dayOfMonth: 1 },
    allocations: [{ accountId, mode: "REMAINDER" }],
  });

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy((error) => error instanceof AccountInputError && error.code === code);
}

describe("attachBankAccount", () => {
  it("moves the bank account's balances and transactions onto the hand-entered account and removes the copy", async () => {
    await createRule(app, householdId, bill(spend));

    const result = await attach(spend, checking.id);

    expect(result).toEqual({ accountId: spend, movedTransactions: 1, movedBalances: 1 });
    const after = await owner.account.findUniqueOrThrow({ where: { id: spend } });
    expect(after).toMatchObject({
      name: "Ally Spend",
      ownerLabel: "Shared",
      includeInForecast: true,
      plaidItemId: item.id,
      externalAccountId: CHECKING,
      attachedAt: NOW,
      active: true,
    });
    expect(after.cushion?.toFixed()).toBe("500");
    expect(await owner.account.findUnique({ where: { id: checking.id } })).toBeNull();
    expect((await owner.transaction.findFirstOrThrow()).accountId).toBe(spend);
    const snapshots = await owner.balanceSnapshot.findMany({ where: { accountId: spend }, orderBy: { observedAt: "asc" } });
    expect(snapshots.map((s) => [s.source, s.current?.toFixed()])).toEqual([
      ["ACCOUNTS_GET", "100"],
      ["MANUAL", "321"],
    ]);
    expect(await owner.allocation.count({ where: { accountId: spend } })).toBe(1);
    // The connection's other account is untouched.
    expect(await owner.account.findUniqueOrThrow({ where: { id: savings.id } })).toMatchObject({ attachedAt: null, name: SAVINGS });
  });

  it("hands the bank's key to the hand-entered account, so a refresh and a sync land on it", async () => {
    await attach(spend, checking.id);
    api.accountsGet.mockResolvedValueOnce({
      data: accountsGetResponse([
        account({ account_id: CHECKING, name: "Plaid Checking", mask: "0000" }),
        account({ account_id: SAVINGS, name: "Plaid Saving", subtype: "savings", mask: "1111" }),
      ]),
    });
    await refreshItemAccounts(deps(), householdId, item.id);
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({ added: [txn({ transaction_id: "txn_synthetic_2", account_id: CHECKING })], next_cursor: "c1" }),
    );

    expect(await syncItem(deps(), householdId, item.id)).toMatchObject({ status: "SUCCEEDED", added: 1 });

    expect(await owner.account.count({ where: { plaidItemId: item.id } })).toBe(2);
    const after = await owner.account.findUniqueOrThrow({ where: { id: spend } });
    expect([after.name, after.mask]).toEqual(["Ally Spend", "0000"]);
    expect(await owner.transaction.count({ where: { accountId: spend } })).toBe(2);
    expect(await owner.balanceSnapshot.count({ where: { accountId: spend, source: "ACCOUNTS_GET" } })).toBe(2);
  });

  it("refuses, changing nothing, whenever the pair cannot be attached", async () => {
    const other = await seedPerson(owner, "other@example.test");
    const theirs = await createManualAccount(app, other.householdId, { name: "Theirs", kind: "checking", ownerLabel: null, cushion: null });
    const theirItem = await seedConnection(owner, other.householdId, { plaidItemId: "item_theirs" });
    const theirBank = await owner.account.findFirstOrThrow({ where: { plaidItemId: theirItem.id } });
    const archived = await createManualAccount(app, householdId, { name: "Old checking", kind: "checking", ownerLabel: null, cushion: null });
    await archiveManualAccount(app, householdId, archived.id);
    const card = await createManualAccount(app, householdId, { name: "Amex", kind: "credit_card", ownerLabel: null, cushion: null });
    const closed = await seedConnection(owner, householdId, { plaidItemId: "item_closed", status: "DISCONNECTED", token: null });
    const closedBank = await owner.account.findFirstOrThrow({ where: { plaidItemId: closed.id } });
    const live = await owner.plaidItem.create({
      data: { householdId, environment: "PRODUCTION", plaidItemId: "item_live", status: "ACTIVE" },
    });
    const liveBank = await owner.account.create({
      data: { householdId, plaidItemId: live.id, externalAccountId: "acct_live", name: "Live checking", type: "depository", currency: "USD" },
    });
    // A rule that points straight at a bank-only account (the rules service no longer allows it; old data could).
    const start = new Date("2026-12-01T00:00:00Z");
    await owner.rule.create({
      data: {
        householdId,
        name: "Old rule",
        kind: "BILL",
        versions: {
          create: {
            effectiveFrom: start,
            amount: "25",
            recurrence: "MONTHLY",
            anchorDate: start,
            dayOfMonth: 1,
            allocations: { create: { accountId: savings.id, mode: "REMAINDER" } },
          },
        },
      },
    });
    const before = JSON.stringify(await owner.account.findMany({ orderBy: { id: "asc" } }));

    const cases: [target: string, bank: string, code: string][] = [
      [theirs.id, checking.id, "account_not_found"],
      [crypto.randomUUID(), checking.id, "account_not_found"],
      [archived.id, checking.id, "archived"],
      [savings.id, checking.id, "already_linked"],
      [spend, crypto.randomUUID(), "bank_account_not_found"],
      [spend, theirBank.id, "bank_account_not_found"],
      [spend, liveBank.id, "bank_account_not_found"],
      [spend, card.id, "not_plaid"],
      [spend, closedBank.id, "connection_disconnected"],
      [card.id, checking.id, "kind_mismatch"],
      [spend, savings.id, "bank_account_in_use"],
    ];
    for (const [target, bank, code] of cases) await expectCode(attach(target, bank), code);
    await expect(attach(spend, savings.id)).rejects.toMatchObject({ ruleNames: ["Old rule"] });

    expect(JSON.stringify(await owner.account.findMany({ orderBy: { id: "asc" } }))).toBe(before);
    expect((await owner.transaction.findFirstOrThrow()).accountId).toBe(checking.id);

    // Once attached, the hand-entered account cannot itself be attached to another.
    await attach(spend, checking.id);
    const pnc = await createManualAccount(app, householdId, { name: "PNC", kind: "checking", ownerLabel: null, cushion: null });
    await expectCode(attach(pnc.id, spend), "already_attached");
  });

  it("lets only one of two simultaneous attaches of the same bank account through", async () => {
    const pnc = await createManualAccount(app, householdId, { name: "PNC", kind: "checking", ownerLabel: null, cushion: null });

    const results = await Promise.allSettled([attach(spend, checking.id), attach(pnc.id, checking.id)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected");
    expect(refused?.status === "rejected" ? refused.reason : null).toMatchObject({ code: "bank_account_not_found" });
    expect(await owner.account.count({ where: { plaidItemId: item.id, attachedAt: { not: null } } })).toBe(1);
    expect(await owner.transaction.count()).toBe(1);
  });

  it("keeps the account in the forecast from its latest balance, before and after the bank is disconnected", async () => {
    await attach(spend, checking.id);
    await owner.balanceSnapshot.create({
      data: { accountId: spend, observedAt: new Date("2026-11-19T15:00:00Z"), current: "250", currency: "USD", source: "ACCOUNTS_GET" },
    });
    const forecastOf = async () => {
      const input = await loadForecastInput(app, householdId, { environment: "SANDBOX", timeZone: NY, today: "2026-11-20" });
      return { account: input.accounts.find((a) => a.id === spend), snapshot: input.snapshots.get(spend) };
    };
    expect(await forecastOf()).toMatchObject({ account: { name: "Ally Spend", active: true }, snapshot: { date: "2026-11-19", balance: "250" } });

    await disconnectConnection(deps(), householdId, item.id);
    await recordBalances(
      app,
      householdId,
      recordBalancesInput.parse({ asOfDate: "2026-11-20", entries: [{ accountId: spend, balance: "275" }] }),
      NOW,
    );

    expect(await forecastOf()).toMatchObject({ account: { active: true }, snapshot: { date: "2026-11-20", balance: "275" } });
  });
});
