import { randomBytes } from "node:crypto";
import type { ItemStatus, PrismaClient } from "@/generated/prisma/client";
import { createPlaidGateway } from "@/features/plaid/client";
import type { LinkDeps } from "@/features/plaid/types";
import { createTokenCipher, plaidItemTokenContext } from "@/lib/crypto/tokens";
import { createHouseholdWithOwner } from "../../scripts/lib/users.mjs";
import { ACCESS_TOKEN, asPlaidApi, type createFakePlaidApi } from "./fake-plaid";

// Shared setup for the connection-lifecycle tests. All data is synthetic.

export const cipher = createTokenCipher({ current: { keyId: "k1", key: Buffer.alloc(32, 9) } });
export const vault = { encrypt: cipher.encryptToken, decrypt: cipher.decryptToken };

export function makeDeps(
  db: PrismaClient,
  api: ReturnType<typeof createFakePlaidApi>,
  overrides: Partial<LinkDeps> = {},
): LinkDeps {
  return {
    db,
    plaid: createPlaidGateway(asPlaidApi(api)),
    environment: "SANDBOX",
    tokens: vault,
    redirectUri: null,
    ...overrides,
  };
}

export async function seedPerson(owner: PrismaClient, email: string) {
  const { userId, householdId } = await createHouseholdWithOwner(owner, {
    householdName: `Household of ${email}`,
    name: "Person",
    email,
    password: "correct horse battery staple",
  });
  const session = await owner.session.create({
    data: { userId, token: randomBytes(16).toString("hex"), expiresAt: new Date("2027-01-01") },
  });
  return { userId, householdId, sessionId: session.id };
}

/** A stored connection with an encrypted token, two accounts and one balance each. */
export async function seedConnection(
  owner: PrismaClient,
  householdId: string,
  options: { status?: ItemStatus; plaidItemId?: string; token?: string | null } = {},
) {
  const plaidItemId = options.plaidItemId ?? "item_synthetic_1";
  const status = options.status ?? "ACTIVE";
  const token = options.token === undefined ? ACCESS_TOKEN : options.token;
  const item = await owner.plaidItem.create({
    data: {
      householdId,
      environment: "SANDBOX",
      plaidItemId,
      institutionName: "First Platypus Bank",
      status,
      accessTokenCiphertext:
        token === null ? null : cipher.encryptToken(token, plaidItemTokenContext("SANDBOX", plaidItemId)),
    },
  });
  for (const externalAccountId of [`${plaidItemId}_checking`, `${plaidItemId}_savings`]) {
    const account = await owner.account.create({
      data: {
        householdId,
        plaidItemId: item.id,
        externalAccountId,
        name: externalAccountId,
        type: "depository",
        currency: "USD",
        active: status !== "DISCONNECTED",
      },
    });
    await owner.balanceSnapshot.create({
      data: {
        accountId: account.id,
        observedAt: new Date("2026-11-01T12:00:00Z"),
        current: "100",
        currency: "USD",
        source: "ACCOUNTS_GET",
      },
    });
  }
  return item;
}

/** A database whose multi-statement writes fail, as if PostgreSQL went away. */
export function databaseFailingOnTransactions(app: PrismaClient): PrismaClient {
  return new Proxy(app, {
    get(target, prop) {
      if (prop === "$transaction") return () => Promise.reject(new Error("simulated database failure"));
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
