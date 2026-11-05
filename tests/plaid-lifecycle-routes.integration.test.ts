import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { PlaidNotConfiguredError, type LinkDeps } from "@/features/plaid/types";
import { createAuth, type Auth } from "@/lib/auth/auth";
import { createHouseholdWithOwner } from "../scripts/lib/users.mjs";
import {
  ACCESS_TOKEN,
  LINK_TOKEN,
  SECRET_IN_SDK_ERRORS,
  createFakePlaidApi,
  networkError,
} from "./helpers/fake-plaid";
import { makeDeps, seedConnection } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

// Same approach as plaid-routes.integration.test.ts: routes are called as plain
// functions with real sessions from the throwaway database and a fake Plaid SDK.

const BASE_URL = "http://localhost:3000";
const PASSWORD = "correct horse battery staple";
const OAUTH_REDIRECT = "http://localhost:3000/plaid/oauth";

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
  state.auth = createAuth({ db: state.db, secret: "lifecycle-secret-".padEnd(48, "l"), baseURL: BASE_URL });
  state.headers = new Headers();
  state.linkDeps = () => makeDeps(state.db, api, { redirectUri: OAUTH_REDIRECT });
});

async function signIn(email = "owner@example.test") {
  const { householdId } = await createHouseholdWithOwner(owner, {
    householdName: "Lifecycle",
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
  state.headers = new Headers({ cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
  return { householdId };
}

function post(body: unknown, origin: string | null = BASE_URL): Request {
  return new Request(`${BASE_URL}/api/plaid/x`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const routes = {
  reconnect: async () => (await import("@/app/api/plaid/connections/[id]/reconnect/route")).POST,
  disconnect: async () => (await import("@/app/api/plaid/connections/[id]/disconnect/route")).POST,
  deleteHistory: async () => (await import("@/app/api/plaid/connections/[id]/delete-history/route")).POST,
};
const withId = (id: string) => ({ params: Promise.resolve({ id }) });
// Each route takes its own body; sending another route's body is (rightly) a 400.
const bodyFor = (name: "reconnect" | "disconnect" | "deleteHistory") => (name === "deleteHistory" ? { confirm: "DELETE" } : {});

describe.each(["reconnect", "disconnect", "deleteHistory"] as const)("POST …/connections/[id]/%s: guards", (name) => {
  it("refuses an anonymous caller before any call to Plaid", async () => {
    const POST = await routes[name]();

    const response = await POST(post(bodyFor(name)), withId(crypto.randomUUID()));

    expect(response.status).toBe(401);
    expect(api.linkTokenCreate).not.toHaveBeenCalled();
    expect(api.itemRemove).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin or origin-less request even with a valid session", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId);
    const POST = await routes[name]();

    for (const origin of ["https://evil.example", null]) {
      const response = await POST(post(bodyFor(name), origin), withId(item.id));
      expect(response.status).toBe(403);
    }
    expect(api.itemRemove).not.toHaveBeenCalled();
    expect(await owner.plaidItem.count()).toBe(1);
  });

  it("answers 404 for an id that is not a uuid or belongs to someone else", async () => {
    await signIn();
    const other = await createHouseholdWithOwner(owner, {
      householdName: "Other",
      name: "Other",
      email: "other@example.test",
      password: PASSWORD,
    });
    const theirs = await seedConnection(owner, other.householdId, { status: "DISCONNECTED", token: null });
    const POST = await routes[name]();

    for (const id of ["nope", crypto.randomUUID(), theirs.id]) {
      const response = await POST(post(bodyFor(name)), withId(id));
      expect(response.status).toBe(404);
    }
    expect(api.itemRemove).not.toHaveBeenCalled();
    expect(api.linkTokenCreate).not.toHaveBeenCalled();
    expect(await owner.plaidItem.count()).toBe(1);
  });
});

describe("POST …/reconnect", () => {
  it("returns an attempt id and a link token for an update-mode Link", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId, { status: "LOGIN_REQUIRED" });
    const POST = await routes.reconnect();

    const response = await POST(post({}), withId(item.id));
    const body = (await response.json()) as { attemptId: string; linkToken: string };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.linkToken).toBe(LINK_TOKEN);
    expect((await owner.linkAttempt.findUniqueOrThrow({ where: { id: body.attemptId } })).kind).toBe("RECONNECT");
  });

  it("accepts an optional selectAccounts flag and passes it through", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId);
    const POST = await routes.reconnect();

    expect((await POST(post({ selectAccounts: true }), withId(item.id))).status).toBe(200);
    expect(api.linkTokenCreate.mock.calls[0][0]).toMatchObject({ update: { account_selection_enabled: true } });
    expect((await POST(post({}), withId(item.id))).status).toBe(200);
    expect(api.linkTokenCreate.mock.calls[1][0]).not.toHaveProperty("update");
  });

  it.each([
    ["a non-boolean flag", { selectAccounts: "yes" }],
    ["an unknown field", { selectAccounts: true, householdId: "x" }],
    ["not json", "{nope"],
  ])("rejects %s before calling Plaid", async (_name, body) => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId);
    const POST = await routes.reconnect();

    expect((await POST(post(body), withId(item.id))).status).toBe(400);
    expect(api.linkTokenCreate).not.toHaveBeenCalled();
  });

  it("answers 503 when Plaid is not configured", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId);
    state.linkDeps = () => {
      throw new PlaidNotConfiguredError();
    };
    const POST = await routes.reconnect();

    expect((await POST(post({}), withId(item.id))).status).toBe(503);
  });
});

describe("POST …/disconnect", () => {
  it("disconnects and returns only a status, never a token", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId);
    const POST = await routes.disconnect();

    const response = await POST(post({}), withId(item.id));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ status: "DISCONNECTED", removalConfirmed: true });
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(api.itemRemove).toHaveBeenCalledWith({ access_token: ACCESS_TOKEN });
  });

  it("answers a Plaid timeout with 504, leaves the connection retryable, and leaks nothing", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId);
    api.itemRemove.mockRejectedValueOnce(networkError("ECONNABORTED"));
    const POST = await routes.disconnect();

    const response = await POST(post({}), withId(item.id));
    const text = await response.text();

    expect(response.status).toBe(504);
    expect(text).not.toContain(SECRET_IN_SDK_ERRORS);
    expect(text).not.toContain(ACCESS_TOKEN);
    const after = await owner.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.accessTokenCiphertext).not.toBeNull();
  });
});

describe("POST …/delete-history", () => {
  async function disconnectedItem() {
    const { householdId } = await signIn();
    return seedConnection(owner, householdId, { status: "DISCONNECTED", token: null });
  }

  it.each([
    ["no body", ""],
    ["wrong confirmation", { confirm: "yes" }],
    ["lower-case confirmation", { confirm: "delete" }],
    ["extra field", { confirm: "DELETE", householdId: "x" }],
    ["not json", "{nope"],
  ])("requires the exact typed confirmation: %s", async (_name, body) => {
    const item = await disconnectedItem();
    const POST = await routes.deleteHistory();

    const response = await POST(post(body), withId(item.id));

    expect(response.status).toBe(400);
    expect(await owner.plaidItem.count()).toBe(1);
  });

  it("deletes the local history once confirmed", async () => {
    const item = await disconnectedItem();
    const POST = await routes.deleteHistory();

    const response = await POST(post({ confirm: "DELETE" }), withId(item.id));

    expect(response.status).toBe(200);
    expect(await owner.plaidItem.count()).toBe(0);
    expect(await owner.account.count()).toBe(0);
  });

  it("answers 409 for a connection that is still connected", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId);
    const POST = await routes.deleteHistory();

    const response = await POST(post({ confirm: "DELETE" }), withId(item.id));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "not_disconnected" });
    expect(await owner.plaidItem.count()).toBe(1);
  });
});

describe("POST /api/plaid/oauth/resume", () => {
  async function startAttempt() {
    await signIn();
    const { POST } = await import("@/app/api/plaid/link-token/route");
    const response = await POST(post({}));
    return ((await response.json()) as { attemptId: string }).attemptId;
  }
  const resume = async (request: Request) => (await import("@/app/api/plaid/oauth/resume/route")).POST(request);

  it("refuses anonymous and cross-origin callers", async () => {
    expect((await resume(post({ attemptId: crypto.randomUUID() }))).status).toBe(401);

    const attemptId = await startAttempt();
    expect((await resume(post({ attemptId }, "https://evil.example"))).status).toBe(403);
  });

  it("returns the original link token to the session that started the attempt", async () => {
    const attemptId = await startAttempt();

    const response = await resume(post({ attemptId }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ attemptId, linkToken: LINK_TOKEN });
    expect(api.linkTokenCreate).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for an unknown attempt and 410 for an expired one", async () => {
    const attemptId = await startAttempt();
    expect((await resume(post({ attemptId: crypto.randomUUID() }))).status).toBe(404);

    await owner.linkAttempt.update({ where: { id: attemptId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await resume(post({ attemptId }))).status).toBe(410);
    expect((await owner.linkAttempt.findUniqueOrThrow({ where: { id: attemptId } })).linkTokenCiphertext).toBeNull();
  });

  it.each([
    ["not json", "{x"],
    ["bad id", { attemptId: "nope" }],
    ["extra field", { attemptId: "00000000-0000-4000-8000-000000000000", x: 1 }],
  ])("rejects a malformed body: %s", async (_name, body) => {
    await signIn();

    expect((await resume(post(body))).status).toBe(400);
  });
});
