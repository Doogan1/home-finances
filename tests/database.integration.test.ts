import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { Client } from "pg";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { createTestClient, truncateAll } from "./helpers/test-db";

// All data below is synthetic. The database is a throwaway created per run.

const { ownerUrl, appUrl } = inject("testDatabase");
let prisma: PrismaClient;

beforeAll(() => {
  prisma = createTestClient(ownerUrl);
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await truncateAll(prisma);
});

async function seedHousehold() {
  return prisma.household.create({ data: { name: "Test household" } });
}

async function seedItem(
  householdId: string,
  overrides: Partial<Prisma.PlaidItemUncheckedCreateInput> = {},
) {
  return prisma.plaidItem.create({
    data: {
      householdId,
      environment: "SANDBOX",
      plaidItemId: `item_${randomUUID()}`,
      status: "ACTIVE",
      ...overrides,
    },
  });
}

async function seedAccount(
  householdId: string,
  plaidItemId: string,
  overrides: Partial<Prisma.AccountUncheckedCreateInput> = {},
) {
  return prisma.account.create({
    data: {
      householdId,
      plaidItemId,
      externalAccountId: `acct_${randomUUID()}`,
      name: "Checking",
      type: "depository",
      currency: "USD",
      ...overrides,
    },
  });
}

describe("uniqueness of provider identifiers", () => {
  it("rejects a duplicate Plaid item id in the same environment", async () => {
    const household = await seedHousehold();
    await seedItem(household.id, { plaidItemId: "item_dup" });

    await expect(seedItem(household.id, { plaidItemId: "item_dup" })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("allows the same Plaid item id in a different environment", async () => {
    const household = await seedHousehold();
    await seedItem(household.id, { plaidItemId: "item_same", environment: "SANDBOX" });

    await expect(
      seedItem(household.id, { plaidItemId: "item_same", environment: "PRODUCTION" }),
    ).resolves.toBeTruthy();
  });

  it("allows separate Items at the same institution (separate logins)", async () => {
    const household = await seedHousehold();
    const institution = { institutionId: "ins_1", institutionName: "Example Bank" };

    await seedItem(household.id, institution);
    await seedItem(household.id, institution);

    expect(await prisma.plaidItem.count()).toBe(2);
  });

  it("rejects a duplicate external account id within one Item, but not across Items", async () => {
    const household = await seedHousehold();
    const first = await seedItem(household.id);
    const second = await seedItem(household.id);
    await seedAccount(household.id, first.id, { externalAccountId: "acct_dup" });

    await expect(
      seedAccount(household.id, first.id, { externalAccountId: "acct_dup" }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      seedAccount(household.id, second.id, { externalAccountId: "acct_dup" }),
    ).resolves.toBeTruthy();
  });

  it("rejects a duplicate provider transaction id within one Item", async () => {
    const household = await seedHousehold();
    const item = await seedItem(household.id);
    const account = await seedAccount(household.id, item.id);
    const base = {
      accountId: account.id,
      plaidItemId: item.id,
      providerTransactionId: "txn_dup",
      amount: new Prisma.Decimal("12.34"),
      currency: "USD",
      date: new Date("2026-01-15"),
      description: "Coffee",
    };
    await prisma.transaction.create({ data: base });

    await expect(prisma.transaction.create({ data: base })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("rejects duplicate user emails and duplicate session tokens", async () => {
    const user = await prisma.user.create({
      data: { name: "A", email: "a@example.test" },
    });
    await expect(
      prisma.user.create({ data: { name: "A2", email: "a@example.test" } }),
    ).rejects.toMatchObject({ code: "P2002" });

    const session = { userId: user.id, token: "token1", expiresAt: new Date(Date.now() + 1e6) };
    await prisma.session.create({ data: session });
    await expect(prisma.session.create({ data: session })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("rejects a user being a member of the same household twice", async () => {
    const household = await seedHousehold();
    const user = await prisma.user.create({
      data: { name: "M", email: "m@example.test" },
    });
    await prisma.membership.create({ data: { userId: user.id, householdId: household.id } });

    await expect(
      prisma.membership.create({ data: { userId: user.id, householdId: household.id } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("balances and money", () => {
  it("preserves null balances (null is not zero)", async () => {
    const household = await seedHousehold();
    const item = await seedItem(household.id);
    const account = await seedAccount(household.id, item.id);

    const snapshot = await prisma.balanceSnapshot.create({
      data: {
        accountId: account.id,
        observedAt: new Date(),
        current: new Prisma.Decimal("100.00"),
        currency: "USD",
        source: "ACCOUNTS_GET",
      },
    });
    const stored = await prisma.balanceSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } });

    expect(stored.available).toBeNull();
    expect(stored.limit).toBeNull();
    expect(stored.providerUpdatedAt).toBeNull();
    expect(stored.current?.toString()).toBe("100");
  });

  it("stores exact decimals without floating-point drift", async () => {
    const household = await seedHousehold();
    const item = await seedItem(household.id);
    const account = await seedAccount(household.id, item.id);

    const values = ["0.1", "0.2", "12345678901234.5678", "-9.99"];
    for (const [i, value] of values.entries()) {
      await prisma.transaction.create({
        data: {
          accountId: account.id,
          plaidItemId: item.id,
          providerTransactionId: `txn_${i}`,
          amount: new Prisma.Decimal(value),
          currency: "USD",
          date: new Date("2026-02-01"),
          description: "Exactness",
        },
      });
    }
    const rows = await prisma.transaction.findMany({ orderBy: { providerTransactionId: "asc" } });

    expect(rows.map((r) => r.amount.toString())).toEqual(values);
    // 0.1 + 0.2 is exactly 0.3 in decimal arithmetic.
    expect(rows[0].amount.plus(rows[1].amount).toString()).toBe("0.3");
  });
});

describe("foreign keys", () => {
  it("rejects an account for a nonexistent Item", async () => {
    const household = await seedHousehold();

    await expect(seedAccount(household.id, randomUUID())).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects an Item for a nonexistent household", async () => {
    await expect(seedItem(randomUUID())).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects a transaction whose account belongs to a different Item", async () => {
    const household = await seedHousehold();
    const itemA = await seedItem(household.id);
    const itemB = await seedItem(household.id);
    const accountOfA = await seedAccount(household.id, itemA.id);

    await expect(
      prisma.transaction.create({
        data: {
          accountId: accountOfA.id,
          plaidItemId: itemB.id,
          providerTransactionId: "txn_mismatch",
          amount: new Prisma.Decimal("1.00"),
          currency: "USD",
          date: new Date("2026-03-01"),
          description: "Wrong item",
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("deleting an Item removes its accounts, balances, transactions and sync runs", async () => {
    const household = await seedHousehold();
    const item = await seedItem(household.id);
    const account = await seedAccount(household.id, item.id);
    await prisma.balanceSnapshot.create({
      data: { accountId: account.id, observedAt: new Date(), currency: "USD", source: "ACCOUNTS_GET" },
    });
    await prisma.transaction.create({
      data: {
        accountId: account.id,
        plaidItemId: item.id,
        providerTransactionId: "txn_1",
        amount: new Prisma.Decimal("5.00"),
        currency: "USD",
        date: new Date("2026-03-02"),
        description: "x",
      },
    });
    await prisma.syncRun.create({ data: { plaidItemId: item.id } });

    await prisma.plaidItem.delete({ where: { id: item.id } });

    expect(await prisma.account.count()).toBe(0);
    expect(await prisma.balanceSnapshot.count()).toBe(0);
    expect(await prisma.transaction.count()).toBe(0);
    expect(await prisma.syncRun.count()).toBe(0);
  });

  it("refuses to delete a household that still has connections", async () => {
    const household = await seedHousehold();
    await seedItem(household.id);

    await expect(prisma.household.delete({ where: { id: household.id } })).rejects.toMatchObject({
      code: "P2003",
    });
  });

  it("keeps a link attempt for reconciliation when its session is deleted", async () => {
    const household = await seedHousehold();
    const user = await prisma.user.create({ data: { name: "S", email: "s@example.test" } });
    const session = await prisma.session.create({
      data: { userId: user.id, token: "t", expiresAt: new Date(Date.now() + 1e6) },
    });
    const attempt = await prisma.linkAttempt.create({
      data: {
        householdId: household.id,
        sessionId: session.id,
        environment: "SANDBOX",
        expiresAt: new Date(Date.now() + 1e6),
      },
    });

    await prisma.session.delete({ where: { id: session.id } });
    const after = await prisma.linkAttempt.findUniqueOrThrow({ where: { id: attempt.id } });

    expect(after.sessionId).toBeNull();
    expect(after.status).toBe("PENDING");
  });
});

describe("stored token column", () => {
  it("holds opaque ciphertext and can be cleared on disconnect", async () => {
    const household = await seedHousehold();
    const item = await seedItem(household.id, { accessTokenCiphertext: "v1.k1.a.b.c" });
    expect(item.accessTokenCiphertext).toBe("v1.k1.a.b.c");

    const cleared = await prisma.plaidItem.update({
      where: { id: item.id },
      data: { accessTokenCiphertext: null, status: "DISCONNECTED" },
    });

    expect(cleared.accessTokenCiphertext).toBeNull();
  });
});

describe("the restricted application role", () => {
  async function withAppClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: appUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  it("has no administrative attributes", async () => {
    const { rows } = await withAppClient((c) =>
      c.query(
        `select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
         from pg_roles where rolname = current_user`,
      ),
    );

    expect(rows[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    });
  });

  it("can read and write application data", async () => {
    await withAppClient(async (c) => {
      const email = `role-${randomUUID()}@example.test`;
      const inserted = await c.query(
        `insert into "User" (id, name, email, "updatedAt")
         values (gen_random_uuid(), 'Role probe', $1, now()) returning id`,
        [email],
      );
      await c.query(`update "User" set name = 'Renamed' where id = $1`, [inserted.rows[0].id]);
      const selected = await c.query(`select email from "User" where id = $1`, [inserted.rows[0].id]);
      expect(selected.rows[0].email).toBe(email);
      await c.query(`delete from "User" where id = $1`, [inserted.rows[0].id]);
    });
  });

  it.each([
    ["create tables", `create table role_probe (id int)`],
    ["alter tables", `alter table "User" add column probe int`],
    ["drop tables", `drop table "User"`],
    ["truncate tables", `truncate table "User"`],
    ["read migration history", `select * from _prisma_migrations`],
    ["create databases", `create database role_probe_db`],
    ["create roles", `create role role_probe_role`],
  ])("cannot %s", async (_label, sql) => {
    await expect(withAppClient((c) => c.query(sql))).rejects.toMatchObject({ code: "42501" });
  });
});
