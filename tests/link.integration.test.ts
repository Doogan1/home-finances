import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createPlaidGateway } from "@/features/plaid/client";
import { refreshItemAccounts } from "@/features/plaid/accounts";
import { createLinkAttempt, exchangeLinkAttempt } from "@/features/plaid/link";
import type { LinkDeps } from "@/features/plaid/types";
import { createTokenCipher, plaidItemTokenContext } from "@/lib/crypto/tokens";
import { createHouseholdWithOwner } from "../scripts/lib/users.mjs";
import {
  ACCESS_TOKEN,
  LINK_TOKEN,
  PUBLIC_TOKEN,
  SECRET_IN_SDK_ERRORS,
  account,
  accountsGetResponse,
  asPlaidApi,
  createFakePlaidApi,
  networkError,
  sdkError,
} from "./helpers/fake-plaid";
import { createTestClient, truncateAll } from "./helpers/test-db";

// Synthetic data only; the Plaid SDK is a fake. No test here can reach Plaid.

const { ownerUrl, appUrl } = inject("testDatabase");
const cipher = createTokenCipher({ current: { keyId: "k1", key: Buffer.alloc(32, 9) } });
const tokens = { encrypt: cipher.encryptToken, decrypt: cipher.decryptToken };

let owner: PrismaClient;
let app: PrismaClient;
let api: ReturnType<typeof createFakePlaidApi>;
let clock: Date;

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
  clock = new Date("2026-11-02T12:00:00Z");
});

function deps(overrides: Partial<LinkDeps> = {}): LinkDeps {
  return {
    db: app,
    plaid: createPlaidGateway(asPlaidApi(api)),
    environment: "SANDBOX",
    tokens,
    now: () => clock,
    ...overrides,
  };
}

async function seedPerson(email: string) {
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

/** A database whose multi-statement writes fail, as if PostgreSQL went away. */
function databaseFailingOnTransactions(): PrismaClient {
  return new Proxy(app, {
    get(target, prop) {
      if (prop === "$transaction") {
        return () => Promise.reject(new Error("simulated database failure"));
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("createLinkAttempt", () => {
  it("creates a short-lived attempt bound to the household, session and environment", async () => {
    const { householdId, sessionId } = await seedPerson("a@example.test");

    const result = await createLinkAttempt(deps(), householdId, sessionId);

    expect(result.linkToken).toBe(LINK_TOKEN);
    const attempt = await owner.linkAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
    expect(attempt).toMatchObject({
      householdId,
      sessionId,
      environment: "SANDBOX",
      status: "PENDING",
      requestedHistoryDays: 365,
    });
    const lifetimeMinutes = (attempt.expiresAt.getTime() - clock.getTime()) / 60_000;
    expect(lifetimeMinutes).toBeGreaterThan(0);
    expect(lifetimeMinutes).toBeLessThanOrEqual(30);
    // The Plaid user id is the household id, not anything personal.
    const request = api.linkTokenCreate.mock.calls[0][0] as { user: { client_user_id: string } };
    expect(request.user.client_user_id).toBe(householdId);
  });

  it("marks the attempt failed with a safe code when Plaid refuses, leaking nothing", async () => {
    const { householdId, sessionId } = await seedPerson("a@example.test");
    api.linkTokenCreate.mockRejectedValueOnce(
      sdkError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_PRODUCT" }),
    );

    const thrown = await createLinkAttempt(deps(), householdId, sessionId).catch((e: unknown) => e);

    expect(thrown).toMatchObject({ code: "provider_error", provider: { kind: "missing_entitlement" } });
    expect(JSON.stringify(thrown)).not.toContain(SECRET_IN_SDK_ERRORS);
    const attempt = await owner.linkAttempt.findFirstOrThrow();
    expect(attempt).toMatchObject({ status: "FAILED", errorCode: "INVALID_PRODUCT" });
  });
});

describe("exchangeLinkAttempt", () => {
  async function startAttempt() {
    const person = await seedPerson("a@example.test");
    const { attemptId } = await createLinkAttempt(deps(), person.householdId, person.sessionId);
    return { ...person, attemptId };
  }

  it("stores an encrypted token, the accounts and a first balance, and returns no secrets", async () => {
    const { householdId, sessionId, attemptId } = await startAttempt();

    const result = await exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN);

    expect(Object.keys(result).sort()).toEqual(["connectionId", "status"]);
    expect(result.status).toBe("ACTIVE");
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);

    const item = await owner.plaidItem.findUniqueOrThrow({ where: { id: result.connectionId } });
    expect(item).toMatchObject({
      householdId,
      environment: "SANDBOX",
      plaidItemId: "item_synthetic_1",
      institutionName: "First Platypus Bank",
      status: "ACTIVE",
    });
    expect(item.accessTokenCiphertext).not.toContain(ACCESS_TOKEN);
    expect(
      cipher.decryptToken(item.accessTokenCiphertext!, plaidItemTokenContext("SANDBOX", "item_synthetic_1")),
    ).toBe(ACCESS_TOKEN);

    const accounts = await owner.account.findMany({ include: { balances: true } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ householdId, externalAccountId: "acct_checking", mask: "0000", active: true });
    expect(accounts[0].balances).toHaveLength(1);
    expect(accounts[0].balances[0].current?.toString()).toBe("110");
    expect(accounts[0].balances[0].observedAt).toEqual(clock);

    const attempt = await owner.linkAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt).toMatchObject({ status: "COMPLETED", plaidItemId: item.id, providerItemId: "item_synthetic_1" });
    expect(api.itemPublicTokenExchange).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired attempt without calling Plaid", async () => {
    const { householdId, sessionId, attemptId } = await startAttempt();
    clock = new Date(clock.getTime() + 31 * 60_000);

    await expect(
      exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN),
    ).rejects.toMatchObject({ code: "attempt_expired" });
    expect(api.itemPublicTokenExchange).not.toHaveBeenCalled();
    expect(await owner.plaidItem.count()).toBe(0);
  });

  it("rejects an attempt started in a different browser session", async () => {
    const { householdId, attemptId } = await startAttempt();
    const otherSession = await owner.session.create({
      data: {
        userId: (await owner.membership.findFirstOrThrow({ where: { householdId } })).userId,
        token: randomBytes(16).toString("hex"),
        expiresAt: new Date("2027-01-01"),
      },
    });

    await expect(
      exchangeLinkAttempt(deps(), householdId, otherSession.id, attemptId, PUBLIC_TOKEN),
    ).rejects.toMatchObject({ code: "attempt_not_found" });
    expect(api.itemPublicTokenExchange).not.toHaveBeenCalled();
  });

  it("rejects another household's attempt, indistinguishably from a missing one", async () => {
    const { attemptId } = await startAttempt();
    const stranger = await seedPerson("stranger@example.test");

    await expect(
      exchangeLinkAttempt(deps(), stranger.householdId, stranger.sessionId, attemptId, PUBLIC_TOKEN),
    ).rejects.toMatchObject({ code: "attempt_not_found" });
    await expect(
      exchangeLinkAttempt(deps(), stranger.householdId, stranger.sessionId, crypto.randomUUID(), PUBLIC_TOKEN),
    ).rejects.toMatchObject({ code: "attempt_not_found" });
    expect(api.itemPublicTokenExchange).not.toHaveBeenCalled();
  });

  it("rejects an attempt once the session that started it has ended", async () => {
    const { householdId, sessionId, attemptId } = await startAttempt();
    await owner.session.delete({ where: { id: sessionId } });

    await expect(
      exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN),
    ).rejects.toMatchObject({ code: "attempt_not_found" });
  });

  it("rejects a replay of a completed attempt and exchanges only once", async () => {
    const { householdId, sessionId, attemptId } = await startAttempt();
    await exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN);

    await expect(
      exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN),
    ).rejects.toMatchObject({ code: "attempt_used" });
    expect(api.itemPublicTokenExchange).toHaveBeenCalledTimes(1);
    expect(await owner.plaidItem.count()).toBe(1);
  });

  it("lets exactly one of two simultaneous exchanges through", async () => {
    const { householdId, sessionId, attemptId } = await startAttempt();

    const outcomes = await Promise.allSettled([
      exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN),
      exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN),
    ]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "attempt_used" });
    expect(api.itemPublicTokenExchange).toHaveBeenCalledTimes(1);
    expect(await owner.plaidItem.count()).toBe(1);
  });

  it("fails an invalid public token cleanly and leaves no item behind", async () => {
    const { householdId, sessionId, attemptId } = await startAttempt();
    api.itemPublicTokenExchange.mockRejectedValueOnce(
      sdkError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_PUBLIC_TOKEN" }),
    );

    await expect(
      exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, "not-a-real-token"),
    ).rejects.toMatchObject({ code: "invalid_public_token" });

    expect(await owner.plaidItem.count()).toBe(0);
    expect(await owner.linkAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({
      status: "FAILED",
      errorCode: "INVALID_PUBLIC_TOKEN",
    });
  });

  it("treats a timeout during the exchange as uncertain, never retrying the consumed token", async () => {
    const { householdId, sessionId, attemptId } = await startAttempt();
    api.itemPublicTokenExchange.mockRejectedValueOnce(networkError("ECONNABORTED"));

    await expect(
      exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN),
    ).rejects.toMatchObject({ code: "provider_error", provider: { kind: "timeout" } });

    expect(api.itemPublicTokenExchange).toHaveBeenCalledTimes(1);
    expect(await owner.linkAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({
      status: "NEEDS_RECONCILIATION",
      errorCode: "timeout",
    });
    await expect(
      exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN),
    ).rejects.toMatchObject({ code: "attempt_used" });
    expect(api.itemPublicTokenExchange).toHaveBeenCalledTimes(1);
  });

  it("after a database failure following a successful exchange: records the Plaid item for reconciliation and removes the orphan", async () => {
    const { householdId, sessionId, attemptId } = await startAttempt();

    await expect(
      exchangeLinkAttempt(
        deps({ db: databaseFailingOnTransactions() }),
        householdId,
        sessionId,
        attemptId,
        PUBLIC_TOKEN,
      ),
    ).rejects.toMatchObject({ code: "persistence_failed" });

    expect(await owner.plaidItem.count()).toBe(0);
    expect(await owner.linkAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({
      status: "NEEDS_RECONCILIATION",
      errorCode: "persistence_failed",
      providerItemId: "item_synthetic_1",
    });
    expect(api.itemRemove).toHaveBeenCalledWith({ access_token: ACCESS_TOKEN });
    expect(api.itemPublicTokenExchange).toHaveBeenCalledTimes(1);
  });

  it("keeps the attempt reconcilable even if orphan cleanup also fails", async () => {
    const { householdId, sessionId, attemptId } = await startAttempt();
    api.itemRemove.mockRejectedValueOnce(networkError("ETIMEDOUT"));

    await expect(
      exchangeLinkAttempt(
        deps({ db: databaseFailingOnTransactions() }),
        householdId,
        sessionId,
        attemptId,
        PUBLIC_TOKEN,
      ),
    ).rejects.toMatchObject({ code: "persistence_failed" });

    const attempt = await owner.linkAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt).toMatchObject({ status: "NEEDS_RECONCILIATION", providerItemId: "item_synthetic_1" });
  });

  it("does not duplicate or remove an existing Item when Plaid returns one we already have", async () => {
    const first = await startAttempt();
    await exchangeLinkAttempt(deps(), first.householdId, first.sessionId, first.attemptId, PUBLIC_TOKEN);
    const second = await createLinkAttempt(deps(), first.householdId, first.sessionId);

    await expect(
      exchangeLinkAttempt(deps(), first.householdId, first.sessionId, second.attemptId, PUBLIC_TOKEN),
    ).rejects.toMatchObject({ code: "duplicate_item" });

    expect(await owner.plaidItem.count()).toBe(1);
    // Removing it at Plaid would destroy the connection we are keeping.
    expect(api.itemRemove).not.toHaveBeenCalled();
    expect(await owner.linkAttempt.findUniqueOrThrow({ where: { id: second.attemptId } })).toMatchObject({
      status: "FAILED",
      errorCode: "duplicate_item",
    });
  });

  it("keeps the connection when the first account fetch fails, and a retry fills it in without re-exchanging", async () => {
    const { householdId, sessionId, attemptId } = await startAttempt();
    api.accountsGet.mockRejectedValueOnce(networkError("ECONNABORTED"));

    const result = await exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN);

    expect(result.status).toBe("PENDING");
    const item = await owner.plaidItem.findUniqueOrThrow({ where: { id: result.connectionId } });
    expect(item).toMatchObject({ status: "PENDING", lastErrorCode: "timeout" });
    expect(await owner.account.count()).toBe(0);
    expect(await owner.linkAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({
      status: "COMPLETED",
    });

    const retried = await refreshItemAccounts(deps(), householdId, result.connectionId);

    expect(retried.status).toBe("ACTIVE");
    expect(await owner.account.count()).toBe(1);
    expect(api.itemPublicTokenExchange).toHaveBeenCalledTimes(1);
    const healed = await owner.plaidItem.findUniqueOrThrow({ where: { id: result.connectionId } });
    expect(healed.lastErrorCode).toBeNull();
  });
});

describe("refreshItemAccounts", () => {
  async function connected() {
    const person = await seedPerson("a@example.test");
    const { attemptId } = await createLinkAttempt(deps(), person.householdId, person.sessionId);
    const { connectionId } = await exchangeLinkAttempt(
      deps(),
      person.householdId,
      person.sessionId,
      attemptId,
      PUBLIC_TOKEN,
    );
    return { ...person, connectionId };
  }

  it("is idempotent for accounts: repeats update in place and add a new balance observation", async () => {
    const { householdId, connectionId } = await connected();
    api.accountsGet.mockResolvedValueOnce({
      data: accountsGetResponse([account({ account_id: "acct_checking", name: "Renamed Checking" })]),
    });
    clock = new Date("2026-11-03T09:00:00Z");

    await refreshItemAccounts(deps(), householdId, connectionId);

    const accounts = await owner.account.findMany({ include: { balances: { orderBy: { observedAt: "asc" } } } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].name).toBe("Renamed Checking");
    expect(accounts[0].balances.map((b) => b.observedAt.toISOString())).toEqual([
      "2026-11-02T12:00:00.000Z",
      "2026-11-03T09:00:00.000Z",
    ]);
  });

  it("marks an account the provider stopped returning as unavailable, and revives it when it returns", async () => {
    const { householdId, connectionId } = await connected();
    api.accountsGet.mockResolvedValueOnce({
      data: accountsGetResponse([account({ account_id: "acct_other", name: "Savings", subtype: "savings" })]),
    });
    clock = new Date("2026-11-03T09:00:00Z");

    await refreshItemAccounts(deps(), householdId, connectionId);

    const gone = await owner.account.findFirstOrThrow({ where: { externalAccountId: "acct_checking" } });
    expect(gone.active).toBe(false);
    expect(gone.unavailableSince).toEqual(clock);
    // Its history is kept, not deleted.
    expect(await owner.balanceSnapshot.count({ where: { accountId: gone.id } })).toBe(1);

    clock = new Date("2026-11-04T09:00:00Z");
    api.accountsGet.mockResolvedValueOnce({
      data: accountsGetResponse([account({ account_id: "acct_checking" }), account({ account_id: "acct_other" })]),
    });
    await refreshItemAccounts(deps(), householdId, connectionId);

    const revived = await owner.account.findFirstOrThrow({ where: { externalAccountId: "acct_checking" } });
    expect(revived).toMatchObject({ active: true, unavailableSince: null });
  });

  it("keeps unreported balances null and stores reported ones exactly", async () => {
    const { householdId, connectionId } = await connected();
    clock = new Date("2026-11-03T09:00:00Z"); // a later observation than the one from linking
    api.accountsGet.mockResolvedValueOnce({
      data: accountsGetResponse([
        account({
          account_id: "acct_checking",
          balances: { available: null, current: 1234.5, limit: null, iso_currency_code: "USD", unofficial_currency_code: null },
        }),
      ]),
    });

    await refreshItemAccounts(deps(), householdId, connectionId);

    const latest = await owner.balanceSnapshot.findFirstOrThrow({ orderBy: { observedAt: "desc" } });
    expect(latest.available).toBeNull();
    expect(latest.limit).toBeNull();
    expect(latest.current?.toString()).toBe("1234.5");
  });

  it("flags the connection when Plaid says the login must be redone", async () => {
    const { householdId, connectionId } = await connected();
    api.accountsGet.mockRejectedValueOnce(
      sdkError(400, { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED" }),
    );

    const result = await refreshItemAccounts(deps(), householdId, connectionId);

    expect(result.status).toBe("LOGIN_REQUIRED");
    expect(await owner.plaidItem.findUniqueOrThrow({ where: { id: connectionId } })).toMatchObject({
      status: "LOGIN_REQUIRED",
      lastErrorCode: "ITEM_LOGIN_REQUIRED",
    });
  });

  it("cannot refresh another household's connection, and does not call Plaid", async () => {
    const { connectionId } = await connected();
    const stranger = await seedPerson("stranger@example.test");
    api.accountsGet.mockClear();

    await expect(refreshItemAccounts(deps(), stranger.householdId, connectionId)).rejects.toMatchObject({
      code: "connection_not_found",
    });
    expect(api.accountsGet).not.toHaveBeenCalled();
  });

  it("fails clearly, without calling Plaid, when the stored token cannot be decrypted", async () => {
    const { householdId, connectionId } = await connected();
    const otherKey = createTokenCipher({ current: { keyId: "k1", key: Buffer.alloc(32, 1) } });
    api.accountsGet.mockClear();

    await expect(
      refreshItemAccounts(
        deps({ tokens: { encrypt: otherKey.encryptToken, decrypt: otherKey.decryptToken } }),
        householdId,
        connectionId,
      ),
    ).rejects.toMatchObject({ code: "token_unreadable" });
    expect(api.accountsGet).not.toHaveBeenCalled();
  });
});
