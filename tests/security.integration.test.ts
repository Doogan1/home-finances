/// <reference types="vite/client" />
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { refreshItemAccounts } from "@/features/plaid/accounts";
import { createReconnectAttempt, deleteConnectionHistory, disconnectConnection } from "@/features/plaid/lifecycle";
import { exchangeLinkAttempt, resumeLinkAttempt } from "@/features/plaid/link";
import {
  listAccountsWithLatestBalance,
  listConnections,
  listRecentTransactions,
  listSyncStatus,
} from "@/features/plaid/queries";
import { syncItem } from "@/features/plaid/sync";
import type { LinkDeps } from "@/features/plaid/types";
import { findHouseholdPlaidItem } from "@/lib/data/connections";
import { createAuth, type Auth } from "@/lib/auth/auth";
import { createHouseholdWithOwner } from "../scripts/lib/users.mjs";
import {
  ACCESS_TOKEN,
  LINK_TOKEN,
  PUBLIC_TOKEN,
  SECRET_IN_SDK_ERRORS,
  createFakePlaidApi,
  networkError,
  sdkError,
  syncPage,
  txn,
} from "./helpers/fake-plaid";
import { databaseFailingOnTransactions, makeDeps, seedConnection } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

// Cross-cutting security properties, checked against the running code and a real
// database: nothing here is a single feature's own test (those exist elsewhere);
// each test asks the same question of EVERY route, service or query.

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

type Person = { email: string; householdId: string; cookie: string; itemId: string; accountId: string; sessionId: string };
let a: Person;
let b: Person;

beforeAll(() => {
  owner = createTestClient(ownerUrl);
  state.db = createTestClient(appUrl);
});
afterAll(async () => {
  await owner.$disconnect();
  await state.db.$disconnect();
});

const plaidCalls = () =>
  Object.values(api).reduce((total, fn) => total + (fn as { mock: { calls: unknown[] } }).mock.calls.length, 0);

async function signIn(email: string): Promise<{ cookie: string }> {
  const response = await state.auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  return { cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}

async function person(email: string, tag: string): Promise<Person> {
  const { householdId } = await createHouseholdWithOwner(owner, { householdName: `House ${tag}`, name: tag, email, password: PASSWORD });
  const item = await seedConnection(owner, householdId, { plaidItemId: `item_${tag}` });
  const account = await owner.account.findFirstOrThrow({ where: { plaidItemId: item.id } });
  await owner.transaction.create({
    data: {
      accountId: account.id,
      plaidItemId: item.id,
      providerTransactionId: `txn_${tag}`,
      amount: "12.34",
      currency: "USD",
      date: new Date("2026-11-01"),
      description: `Purchase of ${tag}`,
    },
  });
  const { cookie } = await signIn(email);
  const session = await owner.session.findFirstOrThrow({ where: { user: { email } } });
  return { email, householdId, cookie, itemId: item.id, accountId: account.id, sessionId: session.id };
}

/** Make the next route/server-function call arrive as this person. */
const as = (p: Person | null) => {
  state.headers = new Headers(p ? { cookie: p.cookie } : {});
};
const deps = (overrides: Partial<LinkDeps> = {}): LinkDeps => makeDeps(state.db, api, { redirectUri: OAUTH_REDIRECT, ...overrides });

beforeEach(async () => {
  await truncateAll(owner);
  api = createFakePlaidApi();
  state.auth = createAuth({ db: state.db, secret: "security-secret-".padEnd(48, "x"), baseURL: BASE_URL });
  state.headers = new Headers();
  state.linkDeps = () => deps();
  a = await person("a@example.test", "a");
  b = await person("b@example.test", "b");
});

function post(body: unknown = {}, origin: string | null = BASE_URL): Request {
  return new Request(`${BASE_URL}/api/plaid/x`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const withId = (id: string) => ({ params: Promise.resolve({ id }) });
// The body each route expects (a wrong body is a 400, which is not what these tests probe).
const bodyForRoute = (file: string) => (file.includes("delete-history") ? { confirm: "DELETE" } : {});

// Every route module under /api/plaid, found from the file system so that a
// route added later is covered automatically.
const routeLoaders = import.meta.glob("../src/app/api/plaid/**/route.ts") as Record<string, () => Promise<{ POST: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> }>>;

function expectUncacheable(response: Response, label: string) {
  const cache = response.headers.get("cache-control") ?? "";
  expect(cache, `${label}: Cache-Control`).toContain("no-store");
  expect(cache, `${label}: Cache-Control`).not.toMatch(/public|s-maxage/);
}

describe("one household can never reach another's data", () => {
  it("services refuse every one of the other household's ids, call no one, and change nothing", async () => {
    const attempt = await owner.linkAttempt.create({
      data: { householdId: a.householdId, sessionId: a.sessionId, environment: "SANDBOX", expiresAt: new Date(Date.now() + 60_000) },
    });
    const before = JSON.stringify({
      items: await owner.plaidItem.findMany({ orderBy: { id: "asc" } }),
      accounts: await owner.account.count(),
      transactions: await owner.transaction.count(),
    });
    const asB = (fn: (d: LinkDeps) => Promise<unknown>) => fn(deps());
    const denied = [
      asB((d) => refreshItemAccounts(d, b.householdId, a.itemId)),
      asB((d) => createReconnectAttempt(d, b.householdId, b.sessionId, a.itemId)),
      asB((d) => disconnectConnection(d, b.householdId, a.itemId)),
      asB((d) => deleteConnectionHistory(d, b.householdId, a.itemId)),
      asB((d) => syncItem(d, b.householdId, a.itemId)),
      asB((d) => exchangeLinkAttempt(d, b.householdId, b.sessionId, attempt.id, PUBLIC_TOKEN)),
      asB((d) => resumeLinkAttempt(d, b.householdId, b.sessionId, attempt.id)),
    ];

    for (const result of await Promise.allSettled(denied)) {
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: expect.stringMatching(/not_found/) });
    }
    expect(plaidCalls()).toBe(0);
    const after = JSON.stringify({
      items: await owner.plaidItem.findMany({ orderBy: { id: "asc" } }),
      accounts: await owner.account.count(),
      transactions: await owner.transaction.count(),
    });
    expect(after).toBe(before);
  });

  it("a household id from the browser is never authority: even A's own attempt fails from B's session", async () => {
    const attempt = await owner.linkAttempt.create({
      data: { householdId: a.householdId, sessionId: b.sessionId, environment: "SANDBOX", expiresAt: new Date(Date.now() + 60_000) },
    });

    // The attempt names B's session but A's household: B's identity cannot claim it.
    await expect(exchangeLinkAttempt(deps(), b.householdId, b.sessionId, attempt.id, PUBLIC_TOKEN)).rejects.toMatchObject({
      code: "attempt_not_found",
    });
  });

  it("queries return only the signed-in household's rows", async () => {
    const env = "SANDBOX" as const;
    const connections = await listConnections(state.db, b.householdId, env);
    const accounts = await listAccountsWithLatestBalance(state.db, b.householdId, env);
    const transactions = await listRecentTransactions(state.db, b.householdId, env);
    const sync = await listSyncStatus(state.db, b.householdId, env);

    expect(connections.map((c) => c.id)).toEqual([b.itemId]);
    expect(accounts.every((x) => x.householdId === b.householdId)).toBe(true);
    expect(accounts.map((x) => x.id)).not.toContain(a.accountId);
    expect(transactions.map((t) => t.description)).toEqual(["Purchase of b"]);
    expect(sync.map((s) => s.id)).toEqual([b.itemId]);
    expect(await findHouseholdPlaidItem(state.db, b.householdId, a.itemId)).toBeNull();
  });

  it("queries never load the stored token, the cursor or the lease", async () => {
    const [connection] = await listConnections(state.db, a.householdId, "SANDBOX");
    const [status] = await listSyncStatus(state.db, a.householdId, "SANDBOX");
    const item = await findHouseholdPlaidItem(state.db, a.householdId, a.itemId);

    for (const row of [connection, status, item!]) {
      expect(row).not.toHaveProperty("accessTokenCiphertext");
      expect(row).not.toHaveProperty("syncCursor");
    }
    expect(status).not.toHaveProperty("syncLeaseToken");
  });

  it("every route answers 404 for the other household's connection, and an anonymous caller gets 401", async () => {
    const idRoutes = Object.entries(routeLoaders).filter(([file]) => file.includes("[id]"));
    expect(idRoutes.length).toBeGreaterThanOrEqual(5);

    for (const [file, load] of idRoutes) {
      const { POST } = await load();
      as(b);
      const foreign = await POST(post(bodyForRoute(file)), withId(a.itemId));
      expect(foreign.status, `${file} (other household)`).toBe(404);
      as(null);
      const anonymous = await POST(post(bodyForRoute(file)), withId(a.itemId));
      expect(anonymous.status, `${file} (anonymous)`).toBe(401);
    }
    expect(plaidCalls()).toBe(0);
    expect(await owner.plaidItem.count({ where: { id: a.itemId } })).toBe(1);
  });
});

describe("CSRF: a mutating route refuses a request that did not come from this site", () => {
  it("covers every Plaid route that exists", async () => {
    const files = Object.keys(routeLoaders);

    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const must of ["link-token", "exchange", "oauth/resume", "[id]/sync", "[id]/disconnect", "[id]/delete-history", "[id]/reconnect", "[id]/refresh"]) {
      expect(files.some((f) => f.includes(must)), must).toBe(true);
    }
  });

  it("every route answers 403, before doing anything, to another origin or no origin at all, even with a valid session", async () => {
    const attemptsBefore = await owner.linkAttempt.count();
    const itemsBefore = JSON.stringify(await owner.plaidItem.findMany({ orderBy: { id: "asc" } }));
    as(a);

    for (const [file, load] of Object.entries(routeLoaders)) {
      const { POST } = await load();
      for (const origin of ["https://evil.example", "http://localhost:3001", "null", null]) {
        const response = await POST(post({ confirm: "DELETE", attemptId: crypto.randomUUID(), publicToken: PUBLIC_TOKEN }, origin), withId(a.itemId));
        expect(response.status, `${file} with origin ${origin}`).toBe(403);
      }
    }
    expect(plaidCalls()).toBe(0);
    expect(await owner.linkAttempt.count()).toBe(attemptsBefore);
    expect(JSON.stringify(await owner.plaidItem.findMany({ orderBy: { id: "asc" } }))).toBe(itemsBefore);
  });

  it("the sign-in endpoint refuses another origin too (login CSRF)", async () => {
    const response = await state.auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ email: a.email, password: PASSWORD }),
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("responses are never cacheable", () => {
  it("every Plaid route, success or failure, forbids storing the response", async () => {
    // A fresh attempt for B so that exchange and resume have something to work with.
    as(b);
    const { POST: linkToken } = await routeLoaders["../src/app/api/plaid/link-token/route.ts"]();
    const started = await linkToken(post({}), withId(b.itemId));
    expectUncacheable(started, "link-token");
    const { attemptId } = (await started.json()) as { attemptId: string };

    const calls: [string, () => Promise<Response>][] = [];
    const call = async (suffix: string, body: unknown, id = b.itemId, who: Person | null = b) => {
      const { POST } = await routeLoaders[`../src/app/api/plaid/${suffix}/route.ts`]();
      as(who);
      return POST(post(body), withId(id));
    };
    api.transactionsSync.mockResolvedValue(syncPage({ added: [txn({ transaction_id: "t1", account_id: `item_b_checking` })], next_cursor: "c1" }));
    calls.push(
      ["resume ok", () => call("oauth/resume", { attemptId })],
      ["resume bad body", () => call("oauth/resume", { nope: 1 })],
      ["resume anonymous", () => call("oauth/resume", { attemptId }, b.itemId, null)],
      ["exchange ok", () => call("exchange", { attemptId, publicToken: PUBLIC_TOKEN })],
      ["exchange replay", () => call("exchange", { attemptId, publicToken: PUBLIC_TOKEN })],
      ["refresh ok", () => call("connections/[id]/refresh", {})],
      ["sync ok", () => call("connections/[id]/sync", {})],
      ["sync throttled", () => call("connections/[id]/sync", {})],
      ["reconnect ok", () => call("connections/[id]/reconnect", {})],
      ["reconnect foreign", () => call("connections/[id]/reconnect", {}, a.itemId)],
      ["delete refused", () => call("connections/[id]/delete-history", { confirm: "DELETE" })],
      ["disconnect ok", () => call("connections/[id]/disconnect", {})],
      ["delete ok", () => call("connections/[id]/delete-history", { confirm: "DELETE" })],
      ["delete bad body", () => call("connections/[id]/delete-history", { confirm: "no" })],
    );

    const statuses: Record<string, number> = {};
    for (const [label, run] of calls) {
      const response = await run();
      statuses[label] = response.status;
      expectUncacheable(response, label);
    }
    // The battery really exercised successes, refusals and errors.
    expect(Object.values(statuses)).toEqual(expect.arrayContaining([200, 400, 401, 404, 409, 429]));
  });
});

describe("a one-time link cannot be replayed", () => {
  it("the same attempt exchanges once: the second try, and a try from another session, are refused", async () => {
    as(a);
    const { POST: linkToken } = await routeLoaders["../src/app/api/plaid/link-token/route.ts"]();
    const { attemptId } = (await (await linkToken(post({}), withId(a.itemId))).json()) as { attemptId: string };
    const { POST: exchange } = await routeLoaders["../src/app/api/plaid/exchange/route.ts"]();
    api.itemPublicTokenExchange.mockResolvedValue({ data: { access_token: ACCESS_TOKEN, item_id: "item_replay", request_id: "r" } });
    api.accountsGet.mockResolvedValue({ data: { accounts: [], item: { item_id: "item_replay" }, request_id: "r" } });

    // The same person signs in again elsewhere: a different browser session.
    const second = await signIn(a.email);
    const otherSession = new Headers({ cookie: second.cookie });

    state.headers = otherSession;
    expect((await exchange(post({ attemptId, publicToken: PUBLIC_TOKEN }), withId(a.itemId))).status).toBe(404);
    as(a);
    expect((await exchange(post({ attemptId, publicToken: PUBLIC_TOKEN }), withId(a.itemId))).status).toBe(200);
    expect((await exchange(post({ attemptId, publicToken: PUBLIC_TOKEN }), withId(a.itemId))).status).toBe(409);

    expect(api.itemPublicTokenExchange).toHaveBeenCalledTimes(1);
  });

  it("a signed-out session cannot be replayed", async () => {
    const out = await state.auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-out`, { method: "POST", headers: { "content-type": "application/json", origin: BASE_URL, cookie: a.cookie }, body: "{}" }),
    );
    expect(out.status).toBe(200);
    const { POST } = await routeLoaders["../src/app/api/plaid/link-token/route.ts"]();

    as(a); // the old cookie, replayed
    expect((await POST(post({}), withId(a.itemId))).status).toBe(401);
    expect(api.linkTokenCreate).not.toHaveBeenCalled();
  });
});

describe("failures never put a secret in an error body or a log", () => {
  const captured: string[] = [];
  const restore: (() => void)[] = [];

  beforeEach(() => {
    captured.length = 0;
    const record = (...args: unknown[]) => captured.push(args.map((x) => (typeof x === "string" ? x : inspect(x, { depth: 8, showHidden: true }))).join(" "));
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      const spy = vi.spyOn(console, method).mockImplementation(record);
      restore.push(() => spy.mockRestore());
    }
    for (const stream of [process.stdout, process.stderr]) {
      const spy = vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
        record(String(chunk));
        return true;
      }) as never);
      restore.push(() => spy.mockRestore());
    }
  });
  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  it("provider errors, database failures, unreadable tokens and bad sign-ins leak nothing", async () => {
    const WRONG_PASSWORD = "wrong-password-distinctive-9d3f";
    const bodies: string[] = [];
    const leak = (message: string) => sdkError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS", request_id: message });
    const secrets = [SECRET_IN_SDK_ERRORS, ACCESS_TOKEN, PUBLIC_TOKEN, LINK_TOKEN, WRONG_PASSWORD, "secret_cursor_value", a.cookie.split("=")[1] ?? "x"];

    const run = async (suffix: string, body: unknown, who: Person, id = who.itemId) => {
      const { POST } = await routeLoaders[`../src/app/api/plaid/${suffix}/route.ts`]();
      as(who);
      const response = await POST(post(body), withId(id));
      bodies.push(await response.text());
      return response;
    };

    // Plaid fails in every way, every time with the secret inside the SDK error.
    api.linkTokenCreate.mockRejectedValue(leak("link"));
    api.itemPublicTokenExchange.mockRejectedValue(leak("exchange"));
    api.accountsGet.mockRejectedValue(leak("accounts"));
    api.itemRemove.mockRejectedValue(networkError("ECONNABORTED"));
    api.transactionsSync.mockRejectedValue(leak("sync"));
    await run("link-token", {}, a);
    const attempt = await owner.linkAttempt.create({
      data: { householdId: a.householdId, sessionId: a.sessionId, environment: "SANDBOX", expiresAt: new Date(Date.now() + 60_000) },
    });
    await run("exchange", { attemptId: attempt.id, publicToken: PUBLIC_TOKEN }, a);
    await run("connections/[id]/refresh", {}, a);
    await run("connections/[id]/sync", {}, a);
    await run("connections/[id]/reconnect", {}, a);
    await run("connections/[id]/disconnect", {}, a);

    // The database fails.
    state.linkDeps = () => deps({ db: databaseFailingOnTransactions(state.db) });
    api.itemPublicTokenExchange.mockResolvedValue({ data: { access_token: ACCESS_TOKEN, item_id: "item_db_fail", request_id: "r" } });
    const attempt2 = await owner.linkAttempt.create({
      data: { householdId: b.householdId, sessionId: b.sessionId, environment: "SANDBOX", expiresAt: new Date(Date.now() + 60_000) },
    });
    await run("exchange", { attemptId: attempt2.id, publicToken: PUBLIC_TOKEN }, b);

    // A stored token that can no longer be read.
    await owner.plaidItem.update({ where: { id: b.itemId }, data: { accessTokenCiphertext: "v1.k9.AAAA.BBBB.CCCC" } });
    state.linkDeps = () => deps();
    await run("connections/[id]/refresh", {}, b);
    await run("connections/[id]/sync", {}, b);

    // Wrong passwords.
    for (let i = 0; i < 3; i++) {
      await state.auth.handler(
        new Request(`${BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify({ email: a.email, password: WRONG_PASSWORD }),
        }),
      );
    }

    expect(bodies.length).toBeGreaterThanOrEqual(9);
    const everything = [...bodies, ...captured].join("\n");
    for (const secret of secrets) expect(everything, `leaked: ${secret.slice(0, 12)}…`).not.toContain(secret);
    expect(everything).not.toContain(PASSWORD);
    // Error bodies are plain codes and messages: no stack traces, SQL or library internals.
    for (const body of bodies) {
      expect(body).not.toMatch(/\bat \w+.*\(|prisma|PrismaClient|select .* from|"stack"|node_modules|AxiosError|request_id/i);
    }
    // The app did log that things failed (so the test is not trivially passing on silence).
    expect(captured.join("\n")).toMatch(/\[plaid\]/);
  });
});
