import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Auth } from "@/lib/auth/auth";
import { createAuth } from "@/lib/auth/auth";
import { createHouseholdWithOwner } from "../scripts/lib/users.mjs";
import { createTestClient, truncateAll } from "./helpers/test-db";

// The guards read the current request through next/headers and the shared auth
// instance. Both are replaced here so they can be driven with real sessions
// from the throwaway database, without a running Next.js server.

const BASE_URL = "http://localhost:3000";
const PASSWORD = "correct horse battery staple";

const state = vi.hoisted(() => ({
  auth: undefined as unknown as Auth,
  db: undefined as unknown as PrismaClient,
  headers: new Headers(),
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
  state.auth = createAuth({ db: state.db, secret: "guard-secret-".padEnd(48, "g"), baseURL: BASE_URL });
  state.headers = new Headers();
});

async function signedInCookie(): Promise<{ cookie: string; householdId: string; userId: string }> {
  const { userId, householdId } = await createHouseholdWithOwner(owner, {
    householdName: "Guarded",
    name: "Owner",
    email: "owner@example.test",
    password: PASSWORD,
  });
  const response = await state.auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email: "owner@example.test", password: PASSWORD }),
    }),
  );
  const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { cookie, householdId, userId };
}

function mutation(origin?: string): Request {
  return new Request(`${BASE_URL}/api/anything`, {
    method: "POST",
    headers: origin ? { origin } : {},
  });
}

describe("requireHousehold", () => {
  it("throws UnauthorizedError when nobody is signed in", async () => {
    const { requireHousehold, UnauthorizedError } = await import("@/lib/auth/household");

    await expect(requireHousehold()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("returns the session's user and household", async () => {
    const { requireHousehold } = await import("@/lib/auth/household");
    const { cookie, userId, householdId } = await signedInCookie();
    state.headers = new Headers({ cookie });

    await expect(requireHousehold()).resolves.toEqual({ userId, householdId });
  });

  it("requireHouseholdOrRedirect sends anonymous visitors to /login", async () => {
    const { requireHouseholdOrRedirect } = await import("@/lib/auth/household");

    await expect(requireHouseholdOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/login");
  });
});

describe("authorizeMutation", () => {
  it("rejects a cross-origin request even when a valid session cookie is sent", async () => {
    const { authorizeMutation } = await import("@/lib/auth/household");
    state.headers = new Headers({ cookie: (await signedInCookie()).cookie });

    const result = await authorizeMutation(mutation("https://evil.example"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("rejects a same-origin request with no session as 401", async () => {
    const { authorizeMutation } = await import("@/lib/auth/household");

    const result = await authorizeMutation(mutation(BASE_URL));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns the household context for a same-origin signed-in request", async () => {
    const { authorizeMutation } = await import("@/lib/auth/household");
    const { cookie, userId, householdId } = await signedInCookie();
    state.headers = new Headers({ cookie });

    const result = await authorizeMutation(mutation(BASE_URL));

    expect(result).toEqual({ ok: true, context: { userId, householdId } });
  });
});

describe("cookie security rule", () => {
  it("refuses to build auth for a non-loopback http URL", () => {
    expect(() =>
      createAuth({ db: state.db, secret: "x".repeat(48), baseURL: "http://finance.example.test" }),
    ).toThrow(/https/);
  });
});
