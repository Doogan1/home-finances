import { describe, expect, it } from "vitest";
import { evaluatePreflight, hasFailures, type PreflightInput } from "@/features/preflight/live-readiness";

// The pre-flight checklist for the first real bank link. Pure rules over a
// snapshot of facts, so every combination can be tested without a database.

const READY: PreflightInput = {
  plaidEnv: "production",
  plaidConfigured: true,
  appUrl: "https://localhost:3000",
  redirectUri: "https://localhost:3000/plaid/oauth",
  retiredKeyCount: 0,
  database: { environments: ["PRODUCTION"], productionItems: 0, roleIsSuperuser: false },
  newestBackupAgeHours: 2,
};

const run = (overrides: Partial<PreflightInput> = {}) => evaluatePreflight({ ...READY, ...overrides });
const byId = (results: ReturnType<typeof run>, id: string) => results.find((r) => r.id === id)!;

describe("a ready production setup", () => {
  it("has no failures and no warnings", () => {
    const results = run();

    expect(hasFailures(results)).toBe(false);
    expect(results.filter((r) => r.level === "WARN" || r.level === "FAIL")).toEqual([]);
    expect(results.every((r) => r.title && r.detail)).toBe(true);
  });

  it("still reminds about the things only a person can check", () => {
    const manual = run().filter((r) => r.level === "MANUAL").map((r) => r.id);

    expect(manual).toEqual(expect.arrayContaining(["disk-encryption", "cloud-sync", "dashboard-redirect", "dashboard-institution", "key-backup", "account-selection"]));
  });
});

describe("redirect address", () => {
  it("is required in production (PNC and most large banks use OAuth)", () => {
    expect(byId(run({ redirectUri: null }), "redirect-set").level).toBe("FAIL");
  });

  it.each([
    ["is on a different host or port than the app", "https://localhost:3001/plaid/oauth"],
    ["is on a different host", "https://finance.example.test/plaid/oauth"],
    ["is not the page this app serves", "https://localhost:3000/oauth"],
  ])("fails when it %s", (_name, redirectUri) => {
    const results = run({ redirectUri });

    expect(byId(results, "redirect-matches-app").level).toBe("FAIL");
    expect(hasFailures(results)).toBe(true);
  });

  it("fails when the app itself is not served over https, since the redirect page is part of the app", () => {
    const results = run({ appUrl: "http://localhost:3000", redirectUri: "http://localhost:3000/plaid/oauth" });

    expect(byId(results, "https").level).toBe("FAIL");
  });
});

describe("keeping real and test data apart", () => {
  it("fails if the database already holds Sandbox data", () => {
    const results = run({ database: { ...READY.database, environments: ["SANDBOX", "PRODUCTION"] } });

    expect(byId(results, "separate-database").level).toBe("FAIL");
    expect(byId(results, "separate-database").detail).toMatch(/separate/i);
  });

  it("warns, from the other side, if a Sandbox setup holds real data", () => {
    const results = run({ plaidEnv: "sandbox", database: { ...READY.database, environments: ["PRODUCTION"] } });

    expect(byId(results, "separate-database").level).toBe("WARN");
  });

  it("passes for an empty database", () => {
    expect(byId(run({ database: { ...READY.database, environments: [] } }), "separate-database").level).toBe("PASS");
  });
});

describe("database access", () => {
  it("fails if the app connects as a superuser", () => {
    const results = run({ database: { ...READY.database, roleIsSuperuser: true } });

    expect(byId(results, "restricted-role").level).toBe("FAIL");
  });
});

describe("backups", () => {
  it.each([
    [null, "FAIL", /npm run backup/],
    [30, "WARN", /old/i],
    [2, "PASS", /.*/],
  ])("with the newest backup %j hours old is %s", (age, level, detail) => {
    const result = byId(run({ newestBackupAgeHours: age }), "recent-backup");

    expect(result.level).toBe(level);
    expect(result.detail).toMatch(detail);
  });
});

describe("the trial's connection allowance", () => {
  it("counts every production connection ever made, since removing one does not free a slot", () => {
    const result = byId(run({ database: { ...READY.database, productionItems: 3 } }), "trial-slots");

    expect(result.level).toBe("INFO");
    expect(result.detail).toContain("3");
    expect(result.detail).toMatch(/even after/i);
  });

  it("warns when the documented limit of 10 is close", () => {
    expect(byId(run({ database: { ...READY.database, productionItems: 8 } }), "trial-slots").level).toBe("WARN");
  });
});

describe("other settings", () => {
  it("fails without Plaid credentials", () => {
    expect(byId(run({ plaidConfigured: false }), "credentials").level).toBe("FAIL");
  });

  it("warns while a key rotation is half done", () => {
    expect(byId(run({ retiredKeyCount: 1 }), "key-rotation").level).toBe("WARN");
  });
});

describe("in Sandbox mode", () => {
  it("never fails: what would block going live is shown as a warning instead", () => {
    const results = run({
      plaidEnv: "sandbox",
      appUrl: "http://localhost:3000",
      redirectUri: null,
      newestBackupAgeHours: null,
      database: { environments: ["SANDBOX"], productionItems: 0, roleIsSuperuser: false },
    });

    expect(hasFailures(results)).toBe(false);
    expect(byId(results, "mode").level).toBe("INFO");
    expect(byId(results, "redirect-set").level).toBe("WARN");
    expect(byId(results, "https").level).toBe("WARN");
    expect(byId(results, "recent-backup").level).toBe("WARN");
  });

  it("but a superuser database role is never acceptable", () => {
    const results = run({ plaidEnv: "sandbox", database: { environments: [], productionItems: 0, roleIsSuperuser: true } });

    expect(byId(results, "restricted-role").level).toBe("FAIL");
  });
});

describe("what it says", () => {
  it("never contains a secret, key, URL credentials or token", () => {
    const text = JSON.stringify(
      run({ appUrl: "https://user:pw@localhost:3000", redirectUri: "https://user:pw@localhost:3000/plaid/oauth?x=secret" }),
    );

    expect(text).not.toContain("pw@");
    expect(text).not.toContain("x=secret");
  });
});
