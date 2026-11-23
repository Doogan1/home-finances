import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { addDays, todayIn } from "@/lib/calendar-date";
import { createAuth, type Auth } from "@/lib/auth/auth";
import { createHouseholdWithOwner } from "../scripts/lib/users.mjs";
import { createTestClient, truncateAll } from "./helpers/test-db";

// Same approach as accounts-routes.integration.test.ts: routes are called as
// plain functions with real sessions from the throwaway database.

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
  state.auth = createAuth({ db: state.db, secret: "occurrence-secret-".padEnd(48, "a"), baseURL: BASE_URL });
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
const json = async (response: Response) => {
  expect(response.headers.get("cache-control")).toContain("no-store");
  return (await response.json()) as Record<string, unknown>;
};

async function account(householdId: string, name: string, type = "depository") {
  const created = await owner.account.create({
    data: { householdId, name, type, subtype: type === "credit" ? "credit card" : "checking", currency: "USD" },
  });
  return created.id;
}

const { POST: createRule } = await import("@/app/api/rules/route");
const { POST: archiveRule } = await import("@/app/api/rules/[id]/archive/route");
const { POST: saveEdit } = await import("@/app/api/rules/[id]/occurrences/[date]/route");
const { POST: resetEdit } = await import("@/app/api/rules/[id]/occurrences/[date]/reset/route");
const { POST: clearAnswer } = await import("@/app/api/rules/[id]/occurrences/[date]/clear/route");
const { POST: recordBalances } = await import("@/app/api/balances/route");
const { POST: setTimeZone } = await import("@/app/api/household/time-zone/route");

const at = (id: string, date: string) => ({ params: Promise.resolve({ id, date }) });
const paid = { status: "PAID", confirmedAmount: null, movedTo: null, note: null };

async function seedBill(email = "owner@example.test") {
  const { householdId } = await signIn(email);
  const spend = await account(householdId, "Ally Spend");
  const created = await createRule(
    post({
      kind: "BILL",
      name: "Mortgage",
      amount: "1840.91",
      schedule: { recurrence: "MONTHLY", interval: 1, anchorDate: "2026-12-01", dayOfMonth: 1 },
      allocations: [{ accountId: spend, mode: "REMAINDER" }],
    }),
  );
  expect(created.status).toBe(201);
  return { householdId, spend, id: ((await json(created)) as { id: string }).id };
}

describe("occurrence routes", () => {
  it("save and reset, every response no-store", async () => {
    const { id } = await seedBill();
    const saved = await saveEdit(post({ ...paid, confirmedAmount: "1,900", status: "CONFIRMED" }), at(id, "2026-12-01"));
    expect(saved.status).toBe(200);
    expect(await json(saved)).toEqual({ ok: true, saved: true });

    const reset = await resetEdit(post({}), at(id, "2026-12-01"));
    expect(reset.status).toBe(200);
    expect(await json(reset)).toEqual({ ok: true, removed: 1 });
  });

  it("refuses with the fixed message for each code", async () => {
    const { id } = await seedBill();
    const confirmed = await saveEdit(post({ ...paid, status: "CONFIRMED" }), at(id, "2026-12-01"));
    expect(confirmed.status).toBe(400);
    expect(await json(confirmed)).toMatchObject({ error: "confirmed_needs_amount", message: "Enter the confirmed amount, or choose another status." });

    const noDate = await saveEdit(post(paid), at(id, "2026-12-02"));
    expect(noDate.status).toBe(404);
    expect(await json(noDate)).toMatchObject({ error: "occurrence_not_found" });

    await archiveRule(post({}), { params: Promise.resolve({ id }) });
    expect((await saveEdit(post(paid), at(id, "2026-12-01"))).status).toBe(409);
  });

  it("rejects bad addresses and bodies that are not exactly the edit", async () => {
    const { id, householdId } = await seedBill();
    expect((await saveEdit(post(paid), at("not-a-uuid", "2026-12-01"))).status).toBe(404);
    expect((await saveEdit(post(paid), at(id, "2026-13-01"))).status).toBe(404);
    for (const body of ["not json", { ...paid, householdId }, { ...paid, status: "DONE" }, { status: "PAID" }, { ...paid, confirmedAmount: "0" }]) {
      expect((await saveEdit(post(body), at(id, "2026-12-01"))).status).toBe(400);
    }
    expect((await resetEdit(post({ extra: true }), at(id, "2026-12-01"))).status).toBe(400);
  });

  it("another household's rule is not found, a cross-site request is refused, and a visitor must sign in", async () => {
    const { id } = await seedBill();
    await seedBill("other@example.test"); // signs in as the other household
    expect((await saveEdit(post(paid), at(id, "2026-12-01"))).status).toBe(404);
    expect((await resetEdit(post({}), at(id, "2026-12-01"))).status).toBe(404);

    expect((await saveEdit(post(paid, "https://evil.example"), at(id, "2026-12-01"))).status).toBe(403);
    state.headers = new Headers();
    expect((await saveEdit(post(paid), at(id, "2026-12-01"))).status).toBe(401);
    expect((await resetEdit(post({}), at(id, "2026-12-01"))).status).toBe(401);
  });

  it("answers Did it clear?, which Update balances counts first", async () => {
    const { householdId } = await signIn("owner@example.test");
    const spend = await account(householdId, "Ally Spend");
    expect((await setTimeZone(post({ timeZone: "America/New_York" }))).status).toBe(200);
    const today = todayIn("America/New_York");
    const yesterday = addDays(today, -1);
    const bill = await createRule(
      post({ kind: "BILL", name: "Electric", amount: "400", schedule: { recurrence: "ONCE", anchorDate: yesterday }, allocations: [{ accountId: spend, mode: "REMAINDER" }] }),
    );
    const { id } = (await json(bill)) as { id: string };

    const recorded = await recordBalances(post({ asOfDate: today, entries: [{ accountId: spend, balance: "2000" }] }));
    expect(await json(recorded)).toEqual({ recorded: 1, questions: 1 });

    for (const body of [{ accountId: spend }, { accountId: spend, answer: "maybe" }, { accountId: "nope", answer: "cleared" }]) {
      expect((await clearAnswer(post(body), at(id, yesterday))).status).toBe(400);
    }
    const cleared = await clearAnswer(post({ accountId: spend, answer: "cleared" }), at(id, yesterday));
    expect(cleared.status).toBe(200);
    expect(await json(cleared)).toEqual({ ok: true });

    const again = await clearAnswer(post({ accountId: spend, answer: "cleared" }), at(id, yesterday));
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ error: "question_not_found" });
  });
});
