import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { refreshItemAccounts } from "@/features/plaid/accounts";
import { createLinkAttempt, exchangeLinkAttempt, resumeLinkAttempt } from "@/features/plaid/link";
import {
  createReconnectAttempt,
  deleteConnectionHistory,
  disconnectConnection,
} from "@/features/plaid/lifecycle";
import { createTokenCipher } from "@/lib/crypto/tokens";
import {
  ACCESS_TOKEN,
  LINK_TOKEN,
  PUBLIC_TOKEN,
  SECRET_IN_SDK_ERRORS,
  createFakePlaidApi,
  networkError,
  sdkError,
} from "./helpers/fake-plaid";
import { cipher, makeDeps, seedConnection, seedPerson, vault } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

// Reconnect (update mode), disconnect, local history deletion and the OAuth
// link-token handling. Plaid is a fake SDK; the database is the throwaway one.

const { ownerUrl, appUrl } = inject("testDatabase");
const OAUTH_REDIRECT = "http://localhost:3000/plaid/oauth";

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

const deps = (overrides = {}) => makeDeps(app, api, { now: () => clock, ...overrides });

describe("createReconnectAttempt (update mode)", () => {
  it("asks Plaid for an update-mode token using the stored access token, with no products", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const item = await seedConnection(owner, person.householdId, { status: "LOGIN_REQUIRED" });

    const result = await createReconnectAttempt(deps(), person.householdId, person.sessionId, item.id);

    expect(result.linkToken).toBe(LINK_TOKEN);
    const request = api.linkTokenCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(request.access_token).toBe(ACCESS_TOKEN);
    expect(request).not.toHaveProperty("products");
    expect(request).not.toHaveProperty("transactions");
    const attempt = await owner.linkAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
    expect(attempt).toMatchObject({
      kind: "RECONNECT",
      status: "PENDING",
      householdId: person.householdId,
      sessionId: person.sessionId,
      plaidItemId: item.id,
    });
  });

  it("is available for any connection that still has a token, not only a flagged one", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const item = await seedConnection(owner, person.householdId, { status: "ACTIVE" });

    await expect(
      createReconnectAttempt(deps(), person.householdId, person.sessionId, item.id),
    ).resolves.toMatchObject({ linkToken: LINK_TOKEN });
  });

  it("cannot reconnect another household's connection, or a disconnected one, and never calls Plaid", async () => {
    const mine = await seedPerson(owner, "a@example.test");
    const theirs = await seedPerson(owner, "b@example.test");
    const theirItem = await seedConnection(owner, theirs.householdId, { plaidItemId: "item_theirs" });
    const closed = await seedConnection(owner, mine.householdId, {
      status: "DISCONNECTED",
      plaidItemId: "item_closed",
      token: null,
    });

    for (const id of [theirItem.id, closed.id, crypto.randomUUID()]) {
      await expect(createReconnectAttempt(deps(), mine.householdId, mine.sessionId, id)).rejects.toMatchObject({
        code: "connection_not_found",
      });
    }
    expect(api.linkTokenCreate).not.toHaveBeenCalled();
    expect(await owner.linkAttempt.count()).toBe(0);
  });

  it("marks the attempt failed with a safe code if Plaid refuses", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const item = await seedConnection(owner, person.householdId);
    api.linkTokenCreate.mockRejectedValueOnce(networkError("ECONNABORTED"));

    const thrown = await createReconnectAttempt(deps(), person.householdId, person.sessionId, item.id).catch(
      (e: unknown) => e,
    );

    expect(thrown).toMatchObject({ code: "provider_error", provider: { kind: "timeout" } });
    expect(JSON.stringify(thrown)).not.toContain(SECRET_IN_SDK_ERRORS);
    expect(await owner.linkAttempt.findFirstOrThrow()).toMatchObject({ status: "FAILED", errorCode: "timeout" });
  });
});

describe("completing a reconnect", () => {
  async function startReconnect(status: "LOGIN_REQUIRED" | "ACTIVE" = "LOGIN_REQUIRED") {
    const person = await seedPerson(owner, "a@example.test");
    const item = await seedConnection(owner, person.householdId, { status });
    await owner.plaidItem.update({
      where: { id: item.id },
      data: { lastErrorCode: "ITEM_LOGIN_REQUIRED", lastErrorAt: clock },
    });
    const { attemptId } = await createReconnectAttempt(deps(), person.householdId, person.sessionId, item.id);
    return { ...person, item, attemptId };
  }

  it("does not exchange the public token; it re-checks the connection and clears the problem", async () => {
    const { householdId, sessionId, item, attemptId } = await startReconnect();
    const before = (await owner.plaidItem.findUniqueOrThrow({ where: { id: item.id } })).accessTokenCiphertext;

    const result = await exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN);

    expect(result).toEqual({ connectionId: item.id, status: "ACTIVE" });
    expect(api.itemPublicTokenExchange).not.toHaveBeenCalled();
    const after = await owner.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ status: "ACTIVE", lastErrorCode: null });
    // Update mode keeps the same access token.
    expect(after.accessTokenCiphertext).toBe(before);
    expect(await owner.linkAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({
      status: "COMPLETED",
      linkTokenCiphertext: null,
    });
  });

  it("leaves the connection flagged if the bank still needs a sign-in", async () => {
    const { householdId, sessionId, item, attemptId } = await startReconnect();
    api.accountsGet.mockRejectedValueOnce(
      sdkError(400, { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED" }),
    );

    const result = await exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN);

    expect(result.status).toBe("LOGIN_REQUIRED");
    expect((await owner.plaidItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("LOGIN_REQUIRED");
  });

  it("rejects replays, other sessions and expired attempts like any other attempt", async () => {
    const { householdId, sessionId, attemptId } = await startReconnect();
    await exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN);

    await expect(
      exchangeLinkAttempt(deps(), householdId, sessionId, attemptId, PUBLIC_TOKEN),
    ).rejects.toMatchObject({ code: "attempt_used" });

    const second = await createReconnectAttempt(
      deps(),
      householdId,
      sessionId,
      (await owner.plaidItem.findFirstOrThrow()).id,
    );
    const stranger = await seedPerson(owner, "stranger@example.test");
    await expect(
      exchangeLinkAttempt(deps(), stranger.householdId, stranger.sessionId, second.attemptId, PUBLIC_TOKEN),
    ).rejects.toMatchObject({ code: "attempt_not_found" });

    clock = new Date(clock.getTime() + 31 * 60_000);
    await expect(
      exchangeLinkAttempt(deps(), householdId, sessionId, second.attemptId, PUBLIC_TOKEN),
    ).rejects.toMatchObject({ code: "attempt_expired" });
  });
});

describe("disconnectConnection", () => {
  it("removes the Item at Plaid, erases the stored token, and keeps the history", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const item = await seedConnection(owner, person.householdId);

    const result = await disconnectConnection(deps(), person.householdId, item.id);

    expect(result).toEqual({ status: "DISCONNECTED", removalConfirmed: true });
    expect(api.itemRemove).toHaveBeenCalledWith({ access_token: ACCESS_TOKEN });
    const after = await owner.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ status: "DISCONNECTED", accessTokenCiphertext: null, lastErrorCode: null });
    const accounts = await owner.account.findMany({ where: { plaidItemId: item.id } });
    expect(accounts.every((a) => !a.active && a.unavailableSince?.getTime() === clock.getTime())).toBe(true);
    expect(await owner.balanceSnapshot.count()).toBe(2);
  });

  it("keeps a retryable state when Plaid cannot be reached, and a retry then succeeds", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const item = await seedConnection(owner, person.householdId);
    const original = (await owner.plaidItem.findUniqueOrThrow({ where: { id: item.id } })).accessTokenCiphertext;
    api.itemRemove.mockRejectedValueOnce(networkError("ECONNABORTED"));

    await expect(disconnectConnection(deps(), person.householdId, item.id)).rejects.toMatchObject({
      code: "provider_error",
      provider: { kind: "timeout" },
    });

    const stuck = await owner.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stuck).toMatchObject({ status: "ACTIVE", lastErrorCode: "timeout" });
    expect(stuck.accessTokenCiphertext).toBe(original); // still usable for the retry
    expect(await owner.account.count({ where: { active: true } })).toBe(2);

    await expect(disconnectConnection(deps(), person.householdId, item.id)).resolves.toMatchObject({
      status: "DISCONNECTED",
      removalConfirmed: true,
    });
    expect(api.itemRemove).toHaveBeenCalledTimes(2);
  });

  it("disconnects locally but flags it when Plaid says it no longer knows the Item", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const item = await seedConnection(owner, person.householdId);
    api.itemRemove.mockRejectedValueOnce(
      sdkError(400, { error_type: "ITEM_ERROR", error_code: "ITEM_NOT_FOUND" }),
    );

    const result = await disconnectConnection(deps(), person.householdId, item.id);

    expect(result).toEqual({ status: "DISCONNECTED", removalConfirmed: false });
    expect(await owner.plaidItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({
      status: "DISCONNECTED",
      accessTokenCiphertext: null,
      lastErrorCode: "removal_unconfirmed",
    });
  });

  it("still lets the person disconnect locally if the stored token can no longer be read", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const item = await seedConnection(owner, person.householdId);
    const otherKey = createTokenCipher({ current: { keyId: "k1", key: Buffer.alloc(32, 1) } });

    const result = await disconnectConnection(
      deps({ tokens: { encrypt: otherKey.encryptToken, decrypt: otherKey.decryptToken } }),
      person.householdId,
      item.id,
    );

    expect(result).toEqual({ status: "DISCONNECTED", removalConfirmed: false });
    expect(api.itemRemove).not.toHaveBeenCalled();
    expect((await owner.plaidItem.findUniqueOrThrow({ where: { id: item.id } })).lastErrorCode).toBe(
      "removal_unconfirmed",
    );
  });

  it("is idempotent for an already-disconnected connection and does not call Plaid", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const item = await seedConnection(owner, person.householdId, { status: "DISCONNECTED", token: null });

    await expect(disconnectConnection(deps(), person.householdId, item.id)).resolves.toMatchObject({
      status: "DISCONNECTED",
    });
    expect(api.itemRemove).not.toHaveBeenCalled();
  });

  it("cannot disconnect another household's connection", async () => {
    const mine = await seedPerson(owner, "a@example.test");
    const theirs = await seedPerson(owner, "b@example.test");
    const theirItem = await seedConnection(owner, theirs.householdId);

    await expect(disconnectConnection(deps(), mine.householdId, theirItem.id)).rejects.toMatchObject({
      code: "connection_not_found",
    });
    expect(api.itemRemove).not.toHaveBeenCalled();
    expect((await owner.plaidItem.findUniqueOrThrow({ where: { id: theirItem.id } })).status).toBe("ACTIVE");
  });
});

describe("deleteConnectionHistory", () => {
  it("deletes a disconnected connection's accounts and balances and nothing else", async () => {
    const mine = await seedPerson(owner, "a@example.test");
    const theirs = await seedPerson(owner, "b@example.test");
    const closed = await seedConnection(owner, mine.householdId, {
      status: "DISCONNECTED",
      plaidItemId: "item_closed",
      token: null,
    });
    const kept = await seedConnection(owner, mine.householdId, { plaidItemId: "item_kept" });
    await seedConnection(owner, theirs.householdId, { plaidItemId: "item_theirs" });
    const attempt = await owner.linkAttempt.create({
      data: {
        householdId: mine.householdId,
        sessionId: mine.sessionId,
        environment: "SANDBOX",
        expiresAt: new Date("2027-01-01"),
        plaidItemId: closed.id,
        status: "COMPLETED",
      },
    });

    await deleteConnectionHistory(deps(), mine.householdId, closed.id);

    expect(await owner.plaidItem.findUnique({ where: { id: closed.id } })).toBeNull();
    expect(await owner.account.count({ where: { plaidItemId: closed.id } })).toBe(0);
    expect(await owner.plaidItem.count()).toBe(2);
    expect(await owner.account.count({ where: { plaidItemId: kept.id } })).toBe(2);
    expect(await owner.account.count()).toBe(4);
    expect(await owner.balanceSnapshot.count()).toBe(4);
    // The record of the attempt survives without pointing at a deleted connection.
    expect((await owner.linkAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).plaidItemId).toBeNull();
  });

  it("refuses to delete a connection that is still connected", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const item = await seedConnection(owner, person.householdId);

    await expect(deleteConnectionHistory(deps(), person.householdId, item.id)).rejects.toMatchObject({
      code: "not_disconnected",
    });
    expect(await owner.plaidItem.count()).toBe(1);
    expect(await owner.account.count()).toBe(2);
  });

  it("cannot delete another household's history", async () => {
    const mine = await seedPerson(owner, "a@example.test");
    const theirs = await seedPerson(owner, "b@example.test");
    const theirItem = await seedConnection(owner, theirs.householdId, { status: "DISCONNECTED", token: null });

    await expect(deleteConnectionHistory(deps(), mine.householdId, theirItem.id)).rejects.toMatchObject({
      code: "connection_not_found",
    });
    expect(await owner.plaidItem.count()).toBe(1);
  });
});

describe("OAuth link-token retention", () => {
  it("keeps no link token when OAuth is not configured, and sends no redirect_uri", async () => {
    const person = await seedPerson(owner, "a@example.test");

    const { attemptId } = await createLinkAttempt(deps({ redirectUri: null }), person.householdId, person.sessionId);

    expect((await owner.linkAttempt.findUniqueOrThrow({ where: { id: attemptId } })).linkTokenCiphertext).toBeNull();
    expect(api.linkTokenCreate.mock.calls[0][0]).not.toHaveProperty("redirect_uri");
    await expect(
      resumeLinkAttempt(deps({ redirectUri: null }), person.householdId, person.sessionId, attemptId),
    ).rejects.toMatchObject({ code: "attempt_not_found" });
  });

  it("sends the redirect URI and keeps the link token only encrypted, bound to the attempt", async () => {
    const person = await seedPerson(owner, "a@example.test");

    const { attemptId } = await createLinkAttempt(
      deps({ redirectUri: OAUTH_REDIRECT }),
      person.householdId,
      person.sessionId,
    );

    expect(api.linkTokenCreate.mock.calls[0][0]).toMatchObject({ redirect_uri: OAUTH_REDIRECT });
    const stored = (await owner.linkAttempt.findUniqueOrThrow({ where: { id: attemptId } })).linkTokenCiphertext!;
    expect(stored).not.toContain(LINK_TOKEN);
    expect(vault.decrypt(stored, `link-attempt:${attemptId}`)).toBe(LINK_TOKEN);
    expect(() => cipher.decryptToken(stored, "link-attempt:someone-else")).toThrow();
  });

  it("returns the SAME link token to the original session for the OAuth return page", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const d = deps({ redirectUri: OAUTH_REDIRECT });
    const { attemptId, linkToken } = await createLinkAttempt(d, person.householdId, person.sessionId);

    const resumed = await resumeLinkAttempt(d, person.householdId, person.sessionId, attemptId);

    expect(resumed).toEqual({ attemptId, linkToken });
    expect(api.linkTokenCreate).toHaveBeenCalledTimes(1); // no new token was minted
  });

  it("refuses to hand the token to another session, another household or a made-up id", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const stranger = await seedPerson(owner, "b@example.test");
    const d = deps({ redirectUri: OAUTH_REDIRECT });
    const { attemptId } = await createLinkAttempt(d, person.householdId, person.sessionId);
    const otherSession = await owner.session.create({
      data: { userId: person.userId, token: "other-session-token", expiresAt: new Date("2027-01-01") },
    });

    for (const [householdId, sessionId, id] of [
      [person.householdId, otherSession.id, attemptId],
      [stranger.householdId, stranger.sessionId, attemptId],
      [person.householdId, person.sessionId, crypto.randomUUID()],
    ] as const) {
      await expect(resumeLinkAttempt(d, householdId, sessionId, id)).rejects.toMatchObject({
        code: "attempt_not_found",
      });
    }
  });

  it("clears the token when the attempt expires, completes or fails", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const d = deps({ redirectUri: OAUTH_REDIRECT });
    const tokenOf = async (id: string) =>
      (await owner.linkAttempt.findUniqueOrThrow({ where: { id } })).linkTokenCiphertext;

    const expired = (await createLinkAttempt(d, person.householdId, person.sessionId)).attemptId;
    clock = new Date(clock.getTime() + 31 * 60_000);
    await expect(resumeLinkAttempt(d, person.householdId, person.sessionId, expired)).rejects.toMatchObject({
      code: "attempt_expired",
    });
    expect(await tokenOf(expired)).toBeNull();

    clock = new Date("2026-11-02T12:00:00Z");
    const completed = (await createLinkAttempt(d, person.householdId, person.sessionId)).attemptId;
    await exchangeLinkAttempt(d, person.householdId, person.sessionId, completed, PUBLIC_TOKEN);
    expect(await tokenOf(completed)).toBeNull();
    await expect(resumeLinkAttempt(d, person.householdId, person.sessionId, completed)).rejects.toMatchObject({
      code: "attempt_used",
    });

    const failed = (await createLinkAttempt(d, person.householdId, person.sessionId)).attemptId;
    api.itemPublicTokenExchange.mockRejectedValueOnce(
      sdkError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_PUBLIC_TOKEN" }),
    );
    await expect(
      exchangeLinkAttempt(d, person.householdId, person.sessionId, failed, "bad"),
    ).rejects.toMatchObject({ code: "invalid_public_token" });
    expect(await tokenOf(failed)).toBeNull();
  });

  it("applies to reconnect attempts too", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const item = await seedConnection(owner, person.householdId, { status: "LOGIN_REQUIRED" });
    const d = deps({ redirectUri: OAUTH_REDIRECT });

    const { attemptId } = await createReconnectAttempt(d, person.householdId, person.sessionId, item.id);

    expect(api.linkTokenCreate.mock.calls[0][0]).toMatchObject({ redirect_uri: OAUTH_REDIRECT });
    await expect(resumeLinkAttempt(d, person.householdId, person.sessionId, attemptId)).resolves.toMatchObject({
      linkToken: LINK_TOKEN,
    });
  });
});

describe("refresh after disconnect", () => {
  it("a disconnected connection can no longer be refreshed", async () => {
    const person = await seedPerson(owner, "a@example.test");
    const item = await seedConnection(owner, person.householdId);
    await disconnectConnection(deps(), person.householdId, item.id);
    api.accountsGet.mockClear();

    await expect(refreshItemAccounts(deps(), person.householdId, item.id)).rejects.toMatchObject({
      code: "connection_not_found",
    });
    expect(api.accountsGet).not.toHaveBeenCalled();
  });
});
