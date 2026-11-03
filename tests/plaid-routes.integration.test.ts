import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createPlaidGateway } from "@/features/plaid/client";
import { PlaidNotConfiguredError, type LinkDeps } from "@/features/plaid/types";
import { createAuth, type Auth } from "@/lib/auth/auth";
import { createTokenCipher } from "@/lib/crypto/tokens";
import { createHouseholdWithOwner } from "../scripts/lib/users.mjs";
import {
  ACCESS_TOKEN,
  LINK_TOKEN,
  PUBLIC_TOKEN,
  SECRET_IN_SDK_ERRORS,
  asPlaidApi,
  createFakePlaidApi,
  networkError,
  sdkError,
} from "./helpers/fake-plaid";
import { createTestClient, truncateAll } from "./helpers/test-db";

// Routes are called as plain functions with real sessions from the throwaway
// database; next/headers and the shared singletons are replaced (as in
// guard.integration.test.ts). Plaid is the fake SDK.

const BASE_URL = "http://localhost:3000";
const PASSWORD = "correct horse battery staple";
const cipher = createTokenCipher({ current: { keyId: "k1", key: Buffer.alloc(32, 9) } });

const state = vi.hoisted(() => ({
  auth: undefined as unknown as Auth,
  db: undefined as unknown as PrismaClient,
  headers: new Headers(),
  linkDeps: (() => {
    throw new Error("not set");
  }) as () => LinkDeps,
}));

vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/config", () => ({ getServerConfig: () => ({ appUrl: BASE_URL }) }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/auth")>()),
  getAuth: () => state.auth,
}));
vi.mock("@/features/plaid/deps", () => ({ getLinkDeps: () => state.linkDeps() }));

const { ownerUrl, appUrl } = inject("testDatabase");
let owner: PrismaClient;
let api: ReturnType<typeof createFakePlaidApi>;

beforeAll(() => {
  owner = createTestClient(ownerUrl);
  state.db = createTestClient(appUrl);
});
afterAll(async () => {
  await owner.$disconnect();
  await state.db.$disconnect();
});
beforeEach(async () => {
  await truncateAll(owner);
  api = createFakePlaidApi();
  state.auth = createAuth({ db: state.db, secret: "routes-secret-".padEnd(48, "r"), baseURL: BASE_URL });
  state.headers = new Headers();
  state.linkDeps = () => ({
    db: state.db,
    plaid: createPlaidGateway(asPlaidApi(api)),
    environment: "SANDBOX",
    tokens: { encrypt: cipher.encryptToken, decrypt: cipher.decryptToken },
  });
});

async function signIn(email = "owner@example.test") {
  const { householdId } = await createHouseholdWithOwner(owner, {
    householdName: "Routes",
    name: "Owner",
    email,
    password: PASSWORD,
  });
  const response = await state.auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  state.headers = new Headers({ cookie });
  return { householdId, cookie };
}

function post(path: string, body: unknown, origin: string | null = BASE_URL): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function linkToken(request = post("/api/plaid/link-token", {})) {
  const { POST } = await import("@/app/api/plaid/link-token/route");
  return POST(request);
}
async function exchange(request: Request) {
  const { POST } = await import("@/app/api/plaid/exchange/route");
  return POST(request);
}

describe("POST /api/plaid/link-token", () => {
  it("refuses an anonymous caller before any call to Plaid", async () => {
    const response = await linkToken();

    expect(response.status).toBe(401);
    expect(api.linkTokenCreate).not.toHaveBeenCalled();
    expect(await owner.linkAttempt.count()).toBe(0);
  });

  it.each([["https://evil.example"], [null]])(
    "refuses a signed-in caller with origin %s before any call to Plaid",
    async (origin) => {
      await signIn();

      const response = await linkToken(post("/api/plaid/link-token", {}, origin));

      expect(response.status).toBe(403);
      expect(api.linkTokenCreate).not.toHaveBeenCalled();
    },
  );

  it("returns an attempt id and a link token, uncacheable", async () => {
    const { householdId } = await signIn();

    const response = await linkToken();
    const body = (await response.json()) as { attemptId: string; linkToken: string };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.linkToken).toBe(LINK_TOKEN);
    const attempt = await owner.linkAttempt.findUniqueOrThrow({ where: { id: body.attemptId } });
    expect(attempt.householdId).toBe(householdId);
  });

  it("answers 503 with a safe message when Plaid credentials are not configured", async () => {
    await signIn();
    state.linkDeps = () => {
      throw new PlaidNotConfiguredError();
    };

    const response = await linkToken();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "plaid_not_configured" });
  });

  it.each([
    [sdkError(429, { error_type: "RATE_LIMIT_EXCEEDED", error_code: "RATE_LIMIT" }), 429, "rate_limited"],
    [networkError("ECONNABORTED"), 504, "timeout"],
    [sdkError(500, { error_type: "API_ERROR", error_code: "INTERNAL_SERVER_ERROR" }), 503, "unavailable"],
    [sdkError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_PRODUCT" }), 422, "missing_entitlement"],
  ])("maps a provider failure to a safe status and message (%#)", async (error, status, kind) => {
    await signIn();
    api.linkTokenCreate.mockRejectedValueOnce(error);

    const response = await linkToken();
    const text = await response.text();

    expect(response.status).toBe(status);
    expect(JSON.parse(text)).toMatchObject({ error: kind });
    // Nothing from the SDK error: not its secret, request, or Plaid's request id.
    for (const forbidden of [SECRET_IN_SDK_ERRORS, ACCESS_TOKEN, "req_error_1", "request_id"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("POST /api/plaid/exchange", () => {
  async function startAttempt() {
    const signedIn = await signIn();
    const body = (await (await linkToken()).json()) as { attemptId: string };
    return { ...signedIn, attemptId: body.attemptId };
  }

  it("refuses an anonymous caller before touching the attempt or Plaid", async () => {
    const response = await exchange(
      post("/api/plaid/exchange", { attemptId: crypto.randomUUID(), publicToken: PUBLIC_TOKEN }),
    );

    expect(response.status).toBe(401);
    expect(api.itemPublicTokenExchange).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request even with a valid session and attempt", async () => {
    const { attemptId } = await startAttempt();

    const response = await exchange(
      post("/api/plaid/exchange", { attemptId, publicToken: PUBLIC_TOKEN }, "https://evil.example"),
    );

    expect(response.status).toBe(403);
    expect(api.itemPublicTokenExchange).not.toHaveBeenCalled();
    expect((await owner.linkAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status).toBe("PENDING");
  });

  it.each([
    ["not json", "{nope"],
    ["missing fields", {}],
    ["attempt id not a uuid", { attemptId: "1; drop table", publicToken: PUBLIC_TOKEN }],
    ["empty token", { attemptId: "00000000-0000-4000-8000-000000000000", publicToken: "" }],
    ["token far too long", { attemptId: "00000000-0000-4000-8000-000000000000", publicToken: "p".repeat(5000) }],
    ["unknown extra field", { attemptId: "00000000-0000-4000-8000-000000000000", publicToken: "x", householdId: "h" }],
  ])("rejects a malformed body: %s", async (_name, body) => {
    await signIn();

    const response = await exchange(post("/api/plaid/exchange", body));

    expect(response.status).toBe(400);
    expect(api.itemPublicTokenExchange).not.toHaveBeenCalled();
  });

  it("exchanges once and returns only a connection id and status", async () => {
    const { attemptId } = await startAttempt();

    const response = await exchange(post("/api/plaid/exchange", { attemptId, publicToken: PUBLIC_TOKEN }));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["connectionId", "status"]);
    const item = await owner.plaidItem.findFirstOrThrow();
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(text).not.toContain(item.accessTokenCiphertext!);
    expect(text).not.toContain(PUBLIC_TOKEN);
  });

  it.each([
    ["a replay", 409, "attempt_used"],
  ])("answers %s with %i", async (_name, status, code) => {
    const { attemptId } = await startAttempt();
    await exchange(post("/api/plaid/exchange", { attemptId, publicToken: PUBLIC_TOKEN }));

    const response = await exchange(post("/api/plaid/exchange", { attemptId, publicToken: PUBLIC_TOKEN }));

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: code });
  });

  it("answers 404 for an attempt that does not exist or belongs to someone else", async () => {
    await signIn();

    const response = await exchange(
      post("/api/plaid/exchange", { attemptId: crypto.randomUUID(), publicToken: PUBLIC_TOKEN }),
    );

    expect(response.status).toBe(404);
  });

  it("answers 410 for an expired attempt", async () => {
    const { attemptId } = await startAttempt();
    await owner.linkAttempt.update({ where: { id: attemptId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await exchange(post("/api/plaid/exchange", { attemptId, publicToken: PUBLIC_TOKEN }));

    expect(response.status).toBe(410);
    expect(api.itemPublicTokenExchange).not.toHaveBeenCalled();
  });

  it("answers a provider timeout with 504 and says the link must be started again", async () => {
    const { attemptId } = await startAttempt();
    api.itemPublicTokenExchange.mockRejectedValueOnce(networkError("ECONNABORTED"));

    const response = await exchange(post("/api/plaid/exchange", { attemptId, publicToken: PUBLIC_TOKEN }));
    const text = await response.text();

    expect(response.status).toBe(504);
    expect(text).not.toContain(SECRET_IN_SDK_ERRORS);
    expect(text).not.toContain(ACCESS_TOKEN);
  });
});

describe("POST /api/plaid/connections/[id]/refresh", () => {
  it("refuses an anonymous caller", async () => {
    const { POST } = await import("@/app/api/plaid/connections/[id]/refresh/route");

    const response = await POST(post("/api/plaid/connections/x/refresh", {}), {
      params: Promise.resolve({ id: crypto.randomUUID() }),
    });

    expect(response.status).toBe(401);
    expect(api.accountsGet).not.toHaveBeenCalled();
  });

  it("answers 404 for another household's connection and never calls Plaid", async () => {
    await signIn();
    const other = await createHouseholdWithOwner(owner, {
      householdName: "Other",
      name: "Other",
      email: "other@example.test",
      password: PASSWORD,
    });
    const item = await owner.plaidItem.create({
      data: { householdId: other.householdId, environment: "SANDBOX", plaidItemId: "item_other", status: "ACTIVE" },
    });
    const { POST } = await import("@/app/api/plaid/connections/[id]/refresh/route");

    const response = await POST(post(`/api/plaid/connections/${item.id}/refresh`, {}), {
      params: Promise.resolve({ id: item.id }),
    });

    expect(response.status).toBe(404);
    expect(api.accountsGet).not.toHaveBeenCalled();
  });

  it("rejects an id that is not a uuid", async () => {
    await signIn();
    const { POST } = await import("@/app/api/plaid/connections/[id]/refresh/route");

    const response = await POST(post("/api/plaid/connections/nope/refresh", {}), {
      params: Promise.resolve({ id: "nope" }),
    });

    expect(response.status).toBe(404);
  });
});

