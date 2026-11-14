import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
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
