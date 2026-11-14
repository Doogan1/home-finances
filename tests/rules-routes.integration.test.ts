import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
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

const { POST: createRule } = await import("@/app/api/rules/route");
const { POST: updateRule } = await import("@/app/api/rules/[id]/update/route");
const { POST: changeRule } = await import("@/app/api/rules/[id]/change/route");
const { POST: stopRule } = await import("@/app/api/rules/[id]/stop/route");
const { POST: archiveRule } = await import("@/app/api/rules/[id]/archive/route");
const { POST: editVersion } = await import("@/app/api/rules/[id]/versions/[versionId]/update/route");
const { POST: archiveAccount } = await import("@/app/api/accounts/[id]/archive/route");

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
  state.auth = createAuth({ db: state.db, secret: "rules-secret-".padEnd(48, "a"), baseURL: BASE_URL });
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
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const versionParams = (id: string, versionId: string) => ({ params: Promise.resolve({ id, versionId }) });
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

const weekly = { recurrence: "WEEKLY", interval: 1, anchorDate: "2026-11-20" };
const incomeBody = (spend: string, savings: string) => ({
  kind: "INCOME",
  name: "Drake paycheck",
  amount: "1,926.94",
  schedule: weekly,
  allocations: [
    { accountId: spend, mode: "PERCENT", value: "70" },
    { accountId: savings, mode: "REMAINDER" },
  ],
});

async function seedRule() {
  const { householdId } = await signIn("owner@example.test");
  const spend = await account(householdId, "Ally Spend");
  const savings = await account(householdId, "Ally Savings");
  const created = await createRule(post(incomeBody(spend, savings)));
  expect(created.status).toBe(201);
  const { id } = (await json(created)) as { id: string };
  const [version] = await owner.ruleVersion.findMany({ where: { ruleId: id } });
  return { householdId, spend, savings, id, versionId: version.id, split: incomeBody(spend, savings).allocations };
}

describe("rule routes", () => {
  it("create, change, stop, edit, rename and archive, every response no-store", async () => {
    const { id, split } = await seedRule();

    const changed = await changeRule(post({ from: "2027-01-01", amount: "1826.94", allocations: split }), params(id));
    expect(changed.status).toBe(200);
    expect(await json(changed)).toMatchObject({ ok: true, versionId: expect.any(String) });

    expect((await stopRule(post({ on: "2027-03-05" }), params(id))).status).toBe(200);

    const versions = await owner.ruleVersion.findMany({ where: { ruleId: id }, orderBy: { effectiveFrom: "asc" } });
    const edited = await editVersion(
      post({
        amount: "1826.94",
        schedule: { recurrence: "WEEKLY", interval: 1, anchorDate: "2027-01-01" },
        allocations: split,
        effectiveTo: null,
      }),
      versionParams(id, versions[1].id),
    );
    expect(edited.status).toBe(200);
    expect(await json(edited)).toEqual({ ok: true });

    expect((await updateRule(post({ name: "Paycheck" }), params(id))).status).toBe(200);
    expect((await archiveRule(post({}), params(id))).status).toBe(200);

    const rule = await owner.rule.findUniqueOrThrow({
      where: { id },
      include: { versions: { orderBy: { effectiveFrom: "asc" } } },
    });
    expect(rule.name).toBe("Paycheck");
    expect(rule.archivedAt).not.toBeNull();
    expect(rule.versions.map((v) => v.effectiveTo?.toISOString().slice(0, 10) ?? null)).toEqual(["2026-12-31", null]);
  });

  it("refuses bodies that aren't exactly right, writing nothing", async () => {
    const { householdId } = await signIn("owner@example.test");
    const spend = await account(householdId, "Ally Spend");
    const savings = await account(householdId, "Ally Savings");
    for (const body of ["not json", { ...incomeBody(spend, savings), householdId }, { ...incomeBody(spend, savings), amount: undefined }]) {
      const response = await createRule(post(body));
      expect(response.status).toBe(400);
      expect(await json(response)).toMatchObject({ error: "invalid_request" });
    }
    expect(await owner.rule.count()).toBe(0);
  });

  it("maps refusals to statuses and messages", async () => {
    const { householdId, id, split } = await seedRule();
    const card = await account(householdId, "Amex", "credit");

    const toCard = await createRule(post({ ...incomeBody(card, card), allocations: [{ accountId: card, mode: "REMAINDER" }] }));
    expect(toCard.status).toBe(400);
    expect(await json(toCard)).toEqual({ error: "income_to_credit", message: "Income can't go to a credit card account." });

    const tooEarly = await changeRule(post({ from: "2026-11-20", amount: "1", allocations: split }), params(id));
    expect(tooEarly.status).toBe(400);
    expect(await json(tooEarly)).toMatchObject({ error: "change_not_after_start" });

    expect((await changeRule(post({ from: "2027-01-01", amount: "1", allocations: split }), params("not-a-uuid"))).status).toBe(404);
    const other = await owner.rule.create({
      data: {
        householdId,
        name: "Other",
        kind: "BILL",
        versions: {
          create: {
            effectiveFrom: new Date("2026-12-01T00:00:00Z"),
            amount: "5",
            recurrence: "ONCE",
            anchorDate: new Date("2026-12-01T00:00:00Z"),
          },
        },
      },
      include: { versions: true },
    });
    const wrongVersion = await editVersion(
      post({ amount: "1", schedule: weekly, allocations: split }),
      versionParams(id, other.versions[0].id),
    );
    expect(wrongVersion.status).toBe(404);
    expect(await json(wrongVersion)).toMatchObject({ error: "version_not_found" });

    await archiveRule(post({}), params(id));
    const archived = await stopRule(post({ on: "2027-01-01" }), params(id));
    expect(archived.status).toBe(409);
    expect(await json(archived)).toEqual({ error: "rule_archived", message: "This is archived, so it can't be changed." });
  });

  it("names the rules when an account they use can't be archived", async () => {
    const { spend } = await seedRule();
    const response = await archiveAccount(post({}), params(spend));
    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      error: "in_use",
      message: "That account is still used by Drake paycheck. Stop or change those first.",
    });
  });

  it("answers 404 for another household's rule", async () => {
    const { id, versionId, split } = await seedRule();
    await signIn("other@example.test");
    const responses = [
      await updateRule(post({ name: "Mine" }), params(id)),
      await changeRule(post({ from: "2027-01-01", amount: "1", allocations: split }), params(id)),
      await stopRule(post({ on: "2027-01-01" }), params(id)),
      await editVersion(post({ amount: "1", schedule: weekly, allocations: split }), versionParams(id, versionId)),
      await archiveRule(post({}), params(id)),
    ];
    for (const response of responses) expect(response.status).toBe(404);
    expect((await owner.rule.findUniqueOrThrow({ where: { id } })).name).toBe("Drake paycheck");
  });

  it("refuses another origin and anonymous callers on every route", async () => {
    const { id, versionId, spend, savings, split } = await seedRule();
    const calls = (origin: string) => [
      () => createRule(post(incomeBody(spend, savings), origin)),
      () => updateRule(post({ name: "x" }, origin), params(id)),
      () => changeRule(post({ from: "2027-01-01", amount: "1", allocations: split }, origin), params(id)),
      () => stopRule(post({ on: "2027-01-01" }, origin), params(id)),
      () => editVersion(post({ amount: "1", schedule: weekly, allocations: split }, origin), versionParams(id, versionId)),
      () => archiveRule(post({}, origin), params(id)),
    ];
    for (const call of calls("https://evil.example")) expect((await call()).status).toBe(403);
    state.headers = new Headers();
    for (const call of calls(BASE_URL)) expect((await call()).status).toBe(401);
    expect(await owner.rule.count()).toBe(1);
    expect(await owner.ruleVersion.count()).toBe(1);
  });
});
