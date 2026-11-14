import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  AccountInputError,
  archiveManualAccount,
  createManualAccount,
  recordBalances,
  setHouseholdTimeZone,
  updateAccount,
} from "@/features/accounts/manual";
import { recordBalancesInput } from "@/features/accounts/input";
import { listAccountsWithLatestBalance } from "@/features/plaid/queries";
import { seedConnection, seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

const { ownerUrl, appUrl } = inject("testDatabase");
let owner: PrismaClient;
let app: PrismaClient;
let householdId: string;

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
  ({ householdId } = await seedPerson(owner, "owner@example.test"));
});

async function manualAccount(data: Record<string, unknown> = {}) {
  return app.account.create({
    data: { householdId, name: "Ally Spend", type: "depository", subtype: "checking", currency: "USD", ...data },
  });
}

describe("database rules for hand-entered accounts", () => {
  it("allows an account with no Plaid link", async () => {
    const account = await manualAccount();
    expect(account.plaidItemId).toBeNull();
    expect(account.includeInForecast).toBe(true);
  });

  it("refuses half a Plaid link", async () => {
    await expect(manualAccount({ externalAccountId: "acc_1" })).rejects.toThrow(/Account_plaid_link_complete/);
  });

  it("refuses a negative cushion", async () => {
    await expect(manualAccount({ cushion: "-1" })).rejects.toThrow(/Account_cushion_not_negative/);
  });

  it("refuses a manual snapshot without an as-of date", async () => {
    const account = await manualAccount();
    await expect(
      app.balanceSnapshot.create({
        data: { accountId: account.id, observedAt: new Date(), current: "10", currency: "USD", source: "MANUAL" },
      }),
    ).rejects.toThrow(/BalanceSnapshot_manual_has_date/);
  });

  it("refuses an empty or oversized household time zone", async () => {
    for (const timeZone of ["", "x".repeat(65)]) {
      await expect(app.household.update({ where: { id: householdId }, data: { timeZone } })).rejects.toThrow(/Household_timeZone_length/);
    }
  });

  it("still lets Plaid accounts and snapshots be written as before", async () => {
    await seedConnection(owner, householdId);
    const accounts = await owner.account.findMany({ where: { householdId }, select: { id: true } });
    await app.balanceSnapshot.create({
      data: { accountId: accounts[0].id, observedAt: new Date(), current: "10", currency: "USD", source: "ACCOUNTS_GET" },
    });
    expect(await app.balanceSnapshot.count()).toBeGreaterThan(0);
  });
});

const balances = (asOfDate: string, entries: { accountId: string; balance: string }[]) =>
  recordBalancesInput.parse({ asOfDate, entries });

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy((error) => error instanceof AccountInputError && error.code === code);
}

describe("the account service", () => {
  it("creates hand-entered accounts with sensible forecast defaults", async () => {
    const spend = await createManualAccount(app, householdId, { name: "Ally Spend", kind: "checking", ownerLabel: "Shared", cushion: "1500" });
    const card = await createManualAccount(app, householdId, { name: "Amex", kind: "credit_card", ownerLabel: null, cushion: null });

    const rows = await owner.account.findMany({ where: { householdId }, orderBy: { name: "asc" } });
    expect(rows.map((r) => [r.name, r.type, r.subtype, r.ownerLabel, r.cushion?.toFixed(), r.includeInForecast])).toEqual([
      ["Ally Spend", "depository", "checking", "Shared", "1500", true],
      ["Amex", "credit", "credit card", null, undefined, false],
    ]);
    expect([spend.id, card.id]).toHaveLength(2);
  });

  it("records several balances as of a date, in one transaction", async () => {
    await setHouseholdTimeZone(app, householdId, "America/New_York");
    const a = await createManualAccount(app, householdId, { name: "Ally Spend", kind: "checking", ownerLabel: null, cushion: null });
    const b = await createManualAccount(app, householdId, { name: "PNC Checking", kind: "checking", ownerLabel: "Drake", cushion: null });

    const result = await recordBalances(app, householdId, balances("2026-11-14", [
      { accountId: a.id, balance: "500" },
      { accountId: b.id, balance: "2305.88" },
    ]), new Date("2026-11-14T18:00:00Z"));

    expect(result).toEqual({ recorded: 2 });
    const rows = await owner.balanceSnapshot.findMany({ orderBy: { current: "asc" } });
    expect(rows.map((r) => [r.source, r.asOfDate?.toISOString().slice(0, 10), r.current?.toFixed()])).toEqual([
      ["MANUAL", "2026-11-14", "500"],
      ["MANUAL", "2026-11-14", "2305.88"],
    ]);
  });

  it("decides 'the future' in the household's time zone", async () => {
    await setHouseholdTimeZone(app, householdId, "America/New_York");
    const a = await createManualAccount(app, householdId, { name: "Ally Spend", kind: "checking", ownerLabel: null, cushion: null });
    const lateEvening = new Date("2026-11-15T03:30:00Z"); // still Nov 14 in New York

    await expect(recordBalances(app, householdId, balances("2026-11-14", [{ accountId: a.id, balance: "1" }]), lateEvening)).resolves.toEqual({ recorded: 1 });
    await expectCode(recordBalances(app, householdId, balances("2026-11-15", [{ accountId: a.id, balance: "1" }]), lateEvening), "future_date");
  });

  it("refuses balances until a time zone is set", async () => {
    const a = await createManualAccount(app, householdId, { name: "Ally Spend", kind: "checking", ownerLabel: null, cushion: null });
    await expectCode(recordBalances(app, householdId, balances("2026-11-14", [{ accountId: a.id, balance: "1" }])), "time_zone_required");
  });

  it("writes nothing when any account is foreign, Plaid-linked or archived", async () => {
    await setHouseholdTimeZone(app, householdId, "America/New_York");
    const mine = await createManualAccount(app, householdId, { name: "Mine", kind: "checking", ownerLabel: null, cushion: null });
    const other = await seedPerson(owner, "other@example.test");
    const theirs = await createManualAccount(app, other.householdId, { name: "Theirs", kind: "checking", ownerLabel: null, cushion: null });
    await seedConnection(owner, householdId);
    const plaid = await owner.account.findFirstOrThrow({ where: { householdId, plaidItemId: { not: null } } });
    const archived = await createManualAccount(app, householdId, { name: "Old", kind: "savings", ownerLabel: null, cushion: null });
    await archiveManualAccount(app, householdId, archived.id);

    const at = new Date("2026-11-14T18:00:00Z");
    for (const [accountId, code] of [[theirs.id, "account_not_found"], [plaid.id, "not_manual"], [archived.id, "archived"]] as const) {
      await expectCode(recordBalances(app, householdId, balances("2026-11-14", [{ accountId: mine.id, balance: "1" }, { accountId, balance: "2" }]), at), code);
    }
    expect(await owner.balanceSnapshot.count({ where: { source: "MANUAL" } })).toBe(0);
  });

  it("lets a Plaid account's label and cushion change, but not its name", async () => {
    await seedConnection(owner, householdId);
    const plaid = await owner.account.findFirstOrThrow({ where: { householdId, plaidItemId: { not: null } } });

    await updateAccount(app, householdId, plaid.id, { ownerLabel: "Drake", cushion: "200" });
    await expectCode(updateAccount(app, householdId, plaid.id, { name: "Renamed" }), "not_manual");
    await expectCode(archiveManualAccount(app, householdId, plaid.id), "not_manual");

    const after = await owner.account.findUniqueOrThrow({ where: { id: plaid.id } });
    expect([after.name, after.ownerLabel, after.cushion?.toFixed()]).toEqual([plaid.name, "Drake", "200"]);
  });

  it("does not let one household touch another's account", async () => {
    const other = await seedPerson(owner, "other@example.test");
    const theirs = await createManualAccount(app, other.householdId, { name: "Theirs", kind: "checking", ownerLabel: null, cushion: null });
    await expectCode(updateAccount(app, householdId, theirs.id, { ownerLabel: "x" }), "account_not_found");
    await expectCode(archiveManualAccount(app, householdId, theirs.id), "account_not_found");
  });

  it("archives without losing history, and archiving twice is harmless", async () => {
    await setHouseholdTimeZone(app, householdId, "America/New_York");
    const a = await createManualAccount(app, householdId, { name: "Old savings", kind: "savings", ownerLabel: null, cushion: null });
    await recordBalances(app, householdId, balances("2026-11-14", [{ accountId: a.id, balance: "10" }]), new Date("2026-11-14T18:00:00Z"));
    await archiveManualAccount(app, householdId, a.id);
    const first = await owner.account.findUniqueOrThrow({ where: { id: a.id } });
    await archiveManualAccount(app, householdId, a.id);
    const second = await owner.account.findUniqueOrThrow({ where: { id: a.id } });

    expect(first.archivedAt).not.toBeNull();
    expect(second.archivedAt).toEqual(first.archivedAt);
    expect(await owner.balanceSnapshot.count({ where: { accountId: a.id } })).toBe(1);
    await expectCode(updateAccount(app, householdId, a.id, { ownerLabel: "x" }), "archived");
  });

  it("shows the balance with the latest as-of date, even if a backdated one was entered later", async () => {
    await setHouseholdTimeZone(app, householdId, "America/New_York");
    const a = await createManualAccount(app, householdId, { name: "Ally Spend", kind: "checking", ownerLabel: null, cushion: null });
    await recordBalances(app, householdId, balances("2026-11-14", [{ accountId: a.id, balance: "500" }]), new Date("2026-11-14T18:00:00Z"));
    await recordBalances(app, householdId, balances("2026-11-10", [{ accountId: a.id, balance: "123" }]), new Date("2026-11-14T19:00:00Z"));

    const [account] = await listAccountsWithLatestBalance(app, householdId, "SANDBOX");
    expect(account.plaidItem).toBeNull();
    expect(account.balances[0].current?.toFixed()).toBe("500");
  });
});
