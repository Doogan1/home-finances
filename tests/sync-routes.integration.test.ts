import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { PlaidNotConfiguredError, type LinkDeps } from "@/features/plaid/types";
import { createAuth, type Auth } from "@/lib/auth/auth";
import { createHouseholdWithOwner } from "../scripts/lib/users.mjs";
import {
  ACCESS_TOKEN,
  SECRET_IN_SDK_ERRORS,
  createFakePlaidApi,
  sdkError,
  syncPage,
  txn,
} from "./helpers/fake-plaid";
import { makeDeps, seedConnection } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

// The sync route, called as a plain function with real sessions and a fake SDK
// (same approach as the other route tests).

const BASE_URL = "http://localhost:3000";
const PASSWORD = "correct horse battery staple";

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
  state.auth = createAuth({ db: state.db, secret: "sync-routes-secret-".padEnd(48, "s"), baseURL: BASE_URL });
  state.headers = new Headers();
  state.linkDeps = () => makeDeps(state.db, api);
});

async function signIn(email = "owner@example.test") {
  const { householdId } = await createHouseholdWithOwner(owner, {
    householdName: "Sync",
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

function post(origin: string | null = BASE_URL): Request {
  return new Request(`${BASE_URL}/api/plaid/connections/x/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: "{}",
  });
}
const withId = (id: string) => ({ params: Promise.resolve({ id }) });
const route = async () => (await import("@/app/api/plaid/connections/[id]/sync/route")).POST;

describe("POST …/connections/[id]/sync", () => {
  it("refuses an anonymous caller before touching Plaid or the database", async () => {
    const POST = await route();

    const response = await POST(post(), withId(crypto.randomUUID()));

    expect(response.status).toBe(401);
    expect(api.transactionsSync).not.toHaveBeenCalled();
    expect(await owner.syncRun.count()).toBe(0);
  });

  it("refuses cross-origin and origin-less requests even with a valid session", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId);
    const POST = await route();

    for (const origin of ["https://evil.example", null]) {
      expect((await POST(post(origin), withId(item.id))).status).toBe(403);
    }
    expect(api.transactionsSync).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed id, a made-up id and another household's connection", async () => {
    await signIn();
    const other = await createHouseholdWithOwner(owner, {
      householdName: "Other",
      name: "Other",
      email: "other@example.test",
      password: PASSWORD,
    });
    const theirs = await seedConnection(owner, other.householdId);
    const POST = await route();

    for (const id of ["nope", crypto.randomUUID(), theirs.id]) {
      expect((await POST(post(), withId(id))).status).toBe(404);
    }
    expect(api.transactionsSync).not.toHaveBeenCalled();
  });

  it("syncs and returns only a summary, uncacheable, with no cursor or token", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId);
    api.transactionsSync.mockResolvedValueOnce(
      syncPage({
        added: [txn({ transaction_id: "t1", account_id: "item_synthetic_1_checking" })],
        next_cursor: "secret_cursor_value",
      }),
    );
    const POST = await route();

    const response = await POST(post(), withId(item.id));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(JSON.parse(text)).toMatchObject({ status: "SUCCEEDED", added: 1, modified: 0, removed: 0, errorCode: null, matched: 0 });
    expect(text).not.toContain("secret_cursor_value");
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      "added", "completedAt", "errorCode", "matched", "modified", "providerStatus", "removed", "runId", "status",
    ]);
  });

  it("reports a failed run as a 200 FAILED summary with a safe code, and leaks nothing", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId);
    api.transactionsSync.mockRejectedValue(sdkError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS" }));
    const POST = await route();

    const response = await POST(post(), withId(item.id));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ status: "FAILED", errorCode: "INVALID_API_KEYS" });
    expect(text).not.toContain(SECRET_IN_SDK_ERRORS);
    expect(text).not.toContain(ACCESS_TOKEN);
  });

  it("throttles a repeat within a minute with 429, Retry-After and a clear message", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId);
    const POST = await route();
    expect((await POST(post(), withId(item.id))).status).toBe(200);

    const second = await POST(post(), withId(item.id));
    const body = (await second.json()) as { error: string; retryAfterSeconds: number };

    expect(second.status).toBe(429);
    expect(body.error).toBe("sync_throttled");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(second.headers.get("retry-after")).toBe(String(body.retryAfterSeconds));
    expect(api.transactionsSync).toHaveBeenCalledTimes(1);
  });

  it("answers 409 while another sync holds the connection", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId);
    await owner.plaidItem.update({
      where: { id: item.id },
      data: { syncLeaseToken: "other", syncLeaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    const POST = await route();

    const response = await POST(post(), withId(item.id));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "sync_in_progress" });
  });

  it("answers 409 reconnect_required for a connection that needs a new sign-in", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId, { status: "LOGIN_REQUIRED" });
    const POST = await route();

    const response = await POST(post(), withId(item.id));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "reconnect_required" });
    expect(api.transactionsSync).not.toHaveBeenCalled();
  });

  it("answers 503 when Plaid is not configured", async () => {
    const { householdId } = await signIn();
    const item = await seedConnection(owner, householdId);
    state.linkDeps = () => {
      throw new PlaidNotConfiguredError();
    };
    const POST = await route();

    expect((await POST(post(), withId(item.id))).status).toBe(503);
  });
});
