import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createAuth, type Auth } from "@/lib/auth/auth";
import { createHouseholdWithOwner } from "../scripts/lib/users.mjs";
import { seedConnection } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

// Same approach as plaid-lifecycle-routes.integration.test.ts: routes are called
// as plain functions with real sessions from the throwaway database.

const BASE_URL = "http://localhost:3000";
const PASSWORD = "correct horse battery staple";

const state = vi.hoisted(() => ({
  auth: undefined as unknown as Auth,
  db: undefined as unknown as PrismaClient,
  headers: new Headers(),
}));

vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("@/lib/config", () => ({ getServerConfig: () => ({ appUrl: BASE_URL }) }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/auth")>()),
  getAuth: () => state.auth,
}));

const { POST: createAccount } = await import("@/app/api/accounts/route");
const { POST: updateAccount } = await import("@/app/api/accounts/[id]/update/route");
const { POST: archiveAccount } = await import("@/app/api/accounts/[id]/archive/route");
const { POST: recordBalances } = await import("@/app/api/balances/route");
const { POST: setTimeZone } = await import("@/app/api/household/time-zone/route");

const { ownerUrl, appUrl } = inject("testDatabase");
let owner: PrismaClient;

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
  state.auth = createAuth({ db: state.db, secret: "accounts-secret-".padEnd(48, "a"), baseURL: BASE_URL });
  state.headers = new Headers();
});

async function signIn(email: string) {
  const { householdId } = await createHouseholdWithOwner(owner, { householdName: email, name: "Owner", email, password: PASSWORD });
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

function post(body: unknown, origin: string | null = BASE_URL): Request {
  return new Request(`${BASE_URL}/api/x`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const withId = (id: string) => ({ params: Promise.resolve({ id }) });

async function json(response: Response) {
  expect(response.headers.get("cache-control")).toContain("no-store");
  return response.json() as Promise<Record<string, unknown>>;
}

describe("hand-entered account routes", () => {
  it("creates an account, sets the time zone and records a balance", async () => {
    const { householdId } = await signIn("a@example.test");

    const created = await createAccount(post({ name: "Ally Spend", kind: "checking", ownerLabel: "Shared", cushion: "1500" }));
    expect(created.status).toBe(201);
    const { id } = (await json(created)) as { id: string };

    expect((await setTimeZone(post({ timeZone: "America/New_York" }))).status).toBe(200);
    const recorded = await recordBalances(post({ asOfDate: "2026-11-14", entries: [{ accountId: id, balance: "500" }] }));
    expect(recorded.status).toBe(200);
    expect(await json(recorded)).toEqual({ recorded: 1 });

    const account = await owner.account.findUniqueOrThrow({ where: { id }, include: { balances: true } });
    expect([account.householdId, account.ownerLabel, account.balances[0].current?.toFixed()]).toEqual([householdId, "Shared", "500"]);
  });

  it("refuses bad bodies with 400 and writes nothing", async () => {
    await signIn("a@example.test");
    for (const body of ["not json", { name: "x" }, { name: "x", kind: "checking", householdId: "00000000-0000-4000-8000-000000000000" }]) {
      const response = await createAccount(post(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await owner.account.count()).toBe(0);
  });

  it("explains a missing time zone and a future date", async () => {
    await signIn("a@example.test");
    const { id } = (await (await createAccount(post({ name: "Ally Spend", kind: "checking" }))).json()) as { id: string };

    const noZone = await recordBalances(post({ asOfDate: "2026-11-14", entries: [{ accountId: id, balance: "1" }] }));
    expect([noZone.status, (await json(noZone)).error]).toEqual([409, "time_zone_required"]);

    await setTimeZone(post({ timeZone: "America/New_York" }));
    const future = await recordBalances(post({ asOfDate: "2999-01-01", entries: [{ accountId: id, balance: "1" }] }));
    expect([future.status, (await json(future)).error]).toEqual([400, "future_date"]);
  });

  it("answers 404 for another household's account, and 409 for a Plaid account's name", async () => {
    const a = await signIn("a@example.test");
    const { id: aAccount } = (await (await createAccount(post({ name: "A's", kind: "checking" }))).json()) as { id: string };
    await seedConnection(owner, a.householdId);
    const plaid = await owner.account.findFirstOrThrow({ where: { householdId: a.householdId, plaidItemId: { not: null } } });

    const renamePlaid = await updateAccount(post({ name: "Renamed" }), withId(plaid.id));
    expect([renamePlaid.status, (await json(renamePlaid)).error]).toEqual([409, "not_manual"]);

    await signIn("b@example.test");
    for (const response of [
      await updateAccount(post({ ownerLabel: "x" }), withId(aAccount)),
      await archiveAccount(post({}), withId(aAccount)),
      await updateAccount(post({ ownerLabel: "x" }), withId("not-a-uuid")),
    ]) {
      expect(response.status).toBe(404);
    }
    expect((await owner.account.findUniqueOrThrow({ where: { id: aAccount } })).archivedAt).toBeNull();
  });

  it("refuses anonymous callers (401) and other origins (403) on every route", async () => {
    const calls = [
      () => createAccount(post({ name: "x", kind: "checking" }, "https://evil.example")),
      () => recordBalances(post({ asOfDate: "2026-11-14", entries: [] }, "https://evil.example")),
      () => setTimeZone(post({ timeZone: "America/New_York" }, "https://evil.example")),
      () => updateAccount(post({ ownerLabel: "x" }, "https://evil.example"), withId("00000000-0000-4000-8000-000000000000")),
      () => archiveAccount(post({}, "https://evil.example"), withId("00000000-0000-4000-8000-000000000000")),
    ];
    await signIn("a@example.test");
    for (const call of calls) expect((await call()).status).toBe(403);

    state.headers = new Headers();
    expect((await createAccount(post({ name: "x", kind: "checking" }))).status).toBe(401);
    expect((await recordBalances(post({ asOfDate: "2026-11-14", entries: [] }))).status).toBe(401);
    expect(await owner.account.count()).toBe(0);
  });
});
