import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { newestBackupAgeHours, readDatabaseFacts } from "@/features/preflight/live-readiness";
import { seedConnection, seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

// The two readers behind `npm run preflight`, against the throwaway database.

const { ownerUrl, appUrl } = inject("testDatabase");
let owner: PrismaClient;
let app: PrismaClient;

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
});

describe("readDatabaseFacts", () => {
  it("recognises the owner as a superuser and the restricted app role as not one", async () => {
    expect((await readDatabaseFacts(owner)).roleIsSuperuser).toBe(true);
    expect((await readDatabaseFacts(app)).roleIsSuperuser).toBe(false);
  });

  it("reports an empty database as holding nothing", async () => {
    expect(await readDatabaseFacts(app)).toEqual({ environments: [], productionItems: 0, roleIsSuperuser: false });
  });

  it("lists which environments exist and counts production connections, disconnected ones included", async () => {
    const { householdId } = await seedPerson(owner, "a@example.test");
    await seedConnection(owner, householdId, { plaidItemId: "item_sandbox" });
    for (const [id, status] of [["item_live_1", "ACTIVE"], ["item_live_2", "DISCONNECTED"]] as const) {
      await owner.plaidItem.create({
        data: { householdId, environment: "PRODUCTION", plaidItemId: id, status, accessTokenCiphertext: null },
      });
    }

    const facts = await readDatabaseFacts(app);

    expect(facts.environments.sort()).toEqual(["PRODUCTION", "SANDBOX"]);
    expect(facts.productionItems).toBe(2); // removing a connection does not free a trial slot
  });
});

describe("newestBackupAgeHours", () => {
  it("returns null when the folder is missing or holds no dumps", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hf-preflight-"));
    try {
      expect(await newestBackupAgeHours(path.join(dir, "does-not-exist"))).toBeNull();
      await writeFile(path.join(dir, "notes.txt"), "not a backup");
      expect(await newestBackupAgeHours(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("measures the newest dump, ignoring older ones and other files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hf-preflight-"));
    const now = new Date("2026-11-04T12:00:00Z");
    try {
      for (const [name, hoursAgo] of [["old.dump", 72], ["new.dump", 5], ["x.txt", 1]] as const) {
        const file = path.join(dir, name);
        await writeFile(file, "x");
        const when = new Date(now.getTime() - hoursAgo * 3_600_000);
        await utimes(file, when, when);
      }

      expect(await newestBackupAgeHours(dir, now)).toBeCloseTo(5, 5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
