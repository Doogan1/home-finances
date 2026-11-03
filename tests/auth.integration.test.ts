import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createAuth, type Auth } from "@/lib/auth/auth";
import { resolveHousehold } from "@/lib/auth/household";
import { findHouseholdPlaidItem } from "@/lib/data/connections";
import {
  UserSetupError,
  addMember,
  createHouseholdWithOwner,
  findSoleHousehold,
} from "../scripts/lib/users.mjs";
import { createTestClient, truncateAll } from "./helpers/test-db";

// Synthetic identities only. The database is a throwaway created per run, and
// the auth system is exercised through the same HTTP handler the app mounts at
// /api/auth/*, using the restricted application database role.

const { ownerUrl, appUrl } = inject("testDatabase");
const BASE_URL = "http://localhost:3000";
const SECRET = "test-secret-".padEnd(48, "s");
const PASSWORD = "correct horse battery staple";

let owner: PrismaClient; // seeds and truncates
let app: PrismaClient; // what the running app would use
let auth: Auth;

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
  auth = createAuth({ db: app, secret: SECRET, baseURL: BASE_URL });
});

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = { origin: BASE_URL },
): Request {
  return new Request(`${BASE_URL}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Cookie request-header value from a response's Set-Cookie headers. */
function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

async function signIn(email: string, password = PASSWORD, origin = BASE_URL) {
  const response = await auth.handler(post("/sign-in/email", { email, password }, { origin }));
  return { response, cookie: cookieHeader(response) };
}

async function seedHouseholdWithOwner(email = "owner@example.test", householdName = "Test") {
  return createHouseholdWithOwner(owner, {
    householdName,
    name: "Owner",
    email,
    password: PASSWORD,
  });
}

describe("closed registration and bootstrap", () => {
  it("creates a household, an owner membership and an Argon2id credential", async () => {
    const { userId, householdId } = await seedHouseholdWithOwner("Owner@Example.TEST");

    const user = await owner.user.findUniqueOrThrow({ where: { id: userId } });
    const membership = await owner.membership.findFirstOrThrow({ where: { userId, householdId } });
    const credential = await owner.authAccount.findFirstOrThrow({ where: { userId } });

    expect(user.email).toBe("owner@example.test");
    expect(membership.role).toBe("OWNER");
    expect(credential.providerId).toBe("credential");
    expect(credential.password?.startsWith("$argon2id$")).toBe(true);
    expect(credential.password).not.toContain(PASSWORD);
  });

  it("rejects a weak password, a duplicate email and a malformed email", async () => {
    await expect(
      createHouseholdWithOwner(owner, { householdName: "H", name: "N", email: "a@example.test", password: "short" }),
    ).rejects.toThrow(UserSetupError);
    await seedHouseholdWithOwner("dup@example.test");
    await expect(seedHouseholdWithOwner("DUP@example.test", "Other")).rejects.toThrow(UserSetupError);
    await expect(
      createHouseholdWithOwner(owner, { householdName: "H", name: "N", email: "not-an-email", password: PASSWORD }),
    ).rejects.toThrow(UserSetupError);
    expect(await owner.household.count()).toBe(1);
  });

  it("adds a second member to the existing household explicitly", async () => {
    const first = await seedHouseholdWithOwner();
    const household = await findSoleHousehold(owner);
    expect(household.id).toBe(first.householdId);

    const second = await addMember(owner, {
      householdId: household.id,
      name: "Partner",
      email: "partner@example.test",
      password: PASSWORD,
    });

    const membership = await owner.membership.findFirstOrThrow({ where: { userId: second.userId } });
    expect(membership.householdId).toBe(first.householdId);
    expect(membership.role).toBe("MEMBER");
    expect((await signIn("partner@example.test")).response.status).toBe(200);
  });

  it("refuses to guess a household when none or several exist", async () => {
    await expect(findSoleHousehold(owner)).rejects.toThrow(UserSetupError);
    await seedHouseholdWithOwner("a@example.test", "One");
    await seedHouseholdWithOwner("b@example.test", "Two");
    await expect(findSoleHousehold(owner)).rejects.toThrow(UserSetupError);
  });

  it("does not let anyone register through the public auth endpoint", async () => {
    const response = await auth.handler(
      post("/sign-up/email", { email: "intruder@example.test", password: PASSWORD, name: "Intruder" }),
    );

    expect(response.ok).toBe(false);
    expect(await owner.user.count()).toBe(0);
  });
});

describe("sign-in", () => {
  it("signs in with the right password and sets a hardened session cookie", async () => {
    await seedHouseholdWithOwner();

    const { response } = await signIn("owner@example.test");
    const setCookie = response.headers.getSetCookie().join("\n").toLowerCase();

    expect(response.status).toBe(200);
    expect(setCookie).toContain("session_token=");
    expect(setCookie).toContain("httponly");
    expect(setCookie).toContain("samesite=lax");
    expect(setCookie).toContain("path=/");
    expect(setCookie).toMatch(/max-age=\d+|expires=/);
    // Loopback development over http: Secure would make the cookie unusable.
    expect(setCookie).not.toContain("secure");
    expect(await owner.session.count()).toBe(1);
  });

  it("marks the cookie Secure when the app URL is https", async () => {
    await seedHouseholdWithOwner();
    const secureAuth = createAuth({ db: app, secret: SECRET, baseURL: "https://finance.example.test" });

    const response = await secureAuth.handler(
      new Request("https://finance.example.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://finance.example.test" },
        body: JSON.stringify({ email: "owner@example.test", password: PASSWORD }),
      }),
    );
    const setCookie = response.headers.getSetCookie().join("\n").toLowerCase();

    expect(response.status).toBe(200);
    expect(setCookie).toContain("secure");
    expect(setCookie).toContain("httponly");
  });

  it("fails identically for a wrong password and an unknown email", async () => {
    await seedHouseholdWithOwner();

    const wrongPassword = await signIn("owner@example.test", "this is not the password");
    const unknownEmail = await signIn("nobody@example.test");

    expect(wrongPassword.response.status).toBe(unknownEmail.response.status);
    expect(wrongPassword.response.status).toBeGreaterThanOrEqual(400);
    expect(await wrongPassword.response.json()).toEqual(await unknownEmail.response.json());
    expect(wrongPassword.cookie).toBe("");
    expect(await owner.session.count()).toBe(0);
  });

  it("throttles repeated failures, even for the right password afterwards", async () => {
    await seedHouseholdWithOwner();

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await signIn("owner@example.test", `wrong password ${i}`)).response.status);
    }
    const afterLockout = await signIn("owner@example.test");

    expect(statuses).toContain(429);
    expect(afterLockout.response.status).toBe(429);
    expect(await owner.session.count()).toBe(0);
  });
});

describe("authorization of requests", () => {
  const ctx = () => ({ auth, db: app });

  it("denies a request without a session", async () => {
    expect(await resolveHousehold(ctx(), new Headers())).toBeNull();
  });

  it("denies a forged or tampered session cookie", async () => {
    await seedHouseholdWithOwner();
    const { cookie } = await signIn("owner@example.test");
    const [name, value] = cookie.split("=");

    expect(await resolveHousehold(ctx(), new Headers({ cookie: `${name}=garbage` }))).toBeNull();
    expect(await resolveHousehold(ctx(), new Headers({ cookie: `${name}=${value.slice(0, -4)}AAAA` }))).toBeNull();
    // A real session token without the signature must not be accepted.
    const row = await owner.session.findFirstOrThrow();
    expect(await resolveHousehold(ctx(), new Headers({ cookie: `${name}=${row.token}` }))).toBeNull();
  });

  it("resolves the user and household from a valid session, never from the client", async () => {
    const { userId, householdId } = await seedHouseholdWithOwner();
    const { cookie } = await signIn("owner@example.test");

    const resolved = await resolveHousehold(
      ctx(),
      new Headers({ cookie, "x-household-id": randomUUID() }),
    );

    expect(resolved).toEqual({ userId, householdId, sessionId: expect.any(String) });
  });

  it("denies an expired session", async () => {
    await seedHouseholdWithOwner();
    const { cookie } = await signIn("owner@example.test");
    await owner.session.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });

    expect(await resolveHousehold(ctx(), new Headers({ cookie }))).toBeNull();
  });

  it("denies a session that has been revoked (row deleted)", async () => {
    await seedHouseholdWithOwner();
    const { cookie } = await signIn("owner@example.test");
    await owner.session.deleteMany();

    expect(await resolveHousehold(ctx(), new Headers({ cookie }))).toBeNull();
  });

  it("denies a signed-in user who belongs to no household", async () => {
    await owner.user.create({ data: { name: "Orphan", email: "orphan@example.test" } });
    const user = await owner.user.findFirstOrThrow();
    const { hashPassword } = await import("@/lib/auth/password");
    await owner.authAccount.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: await hashPassword(PASSWORD),
      },
    });
    const { cookie } = await signIn("orphan@example.test");

    expect(cookie).not.toBe("");
    expect(await resolveHousehold(ctx(), new Headers({ cookie }))).toBeNull();
  });

  it("logout revokes the session server-side, so a stolen cookie stops working", async () => {
    await seedHouseholdWithOwner();
    const { cookie } = await signIn("owner@example.test");
    expect(await resolveHousehold(ctx(), new Headers({ cookie }))).not.toBeNull();

    const out = await auth.handler(post("/sign-out", {}, { origin: BASE_URL, cookie }));

    expect(out.status).toBe(200);
    expect(await owner.session.count()).toBe(0);
    expect(await resolveHousehold(ctx(), new Headers({ cookie }))).toBeNull();
  });
});

describe("cross-origin mutations", () => {
  it("rejects sign-out from another origin and leaves the session intact", async () => {
    await seedHouseholdWithOwner();
    const { cookie } = await signIn("owner@example.test");

    const response = await auth.handler(
      post("/sign-out", {}, { origin: "https://evil.example", cookie }),
    );

    expect(response.status).toBe(403);
    expect(await owner.session.count()).toBe(1);
  });

  it("rejects sign-in from another origin (no login CSRF)", async () => {
    await seedHouseholdWithOwner();

    const { response, cookie } = await signIn("owner@example.test", PASSWORD, "https://evil.example");

    expect(response.status).toBe(403);
    expect(cookie).toBe("");
    expect(await owner.session.count()).toBe(0);
  });
});

describe("cross-household isolation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a second household cannot read the first household's Item", async () => {
    const a = await seedHouseholdWithOwner("a@example.test", "Household A");
    const b = await seedHouseholdWithOwner("b@example.test", "Household B");
    const item = await owner.plaidItem.create({
      data: { householdId: a.householdId, environment: "SANDBOX", plaidItemId: "item_a", status: "ACTIVE" },
    });

    const asB = await findHouseholdPlaidItem(app, b.householdId, item.id);
    const asA = await findHouseholdPlaidItem(app, a.householdId, item.id);

    expect(asB).toBeNull();
    expect(asA?.id).toBe(item.id);
  });

  it("each user's session resolves only to their own household", async () => {
    const a = await seedHouseholdWithOwner("a@example.test", "Household A");
    const b = await seedHouseholdWithOwner("b@example.test", "Household B");

    const sessionA = await signIn("a@example.test");
    const sessionB = await signIn("b@example.test");

    expect(await resolveHousehold({ auth, db: app }, new Headers({ cookie: sessionA.cookie }))).toEqual({
      userId: a.userId,
      householdId: a.householdId,
      sessionId: expect.any(String),
    });
    expect(await resolveHousehold({ auth, db: app }, new Headers({ cookie: sessionB.cookie }))).toEqual({
      userId: b.userId,
      householdId: b.householdId,
      sessionId: expect.any(String),
    });
  });
});
