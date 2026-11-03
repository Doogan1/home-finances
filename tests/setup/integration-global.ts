import { randomBytes } from "node:crypto";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { ensureAppRole, runMigrations, withDatabase } from "../../scripts/lib/database.mjs";

declare module "vitest" {
  export interface ProvidedContext {
    testDatabase: { ownerUrl: string; appUrl: string };
  }
}

const PREFIX = "hf_test_";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Run integration tests inside the app container: ` +
        "`docker compose exec app npm run test:integration`.",
    );
  }
  return value;
}

/**
 * Creates a brand-new, uniquely named database for this test run, applies the
 * committed migrations to it, and drops it afterwards. Tests therefore never
 * read or write the live development database, whatever it contains.
 */
export default async function setup(project: TestProject) {
  const ownerUrl = requireEnv("MIGRATION_DATABASE_URL");
  const appUser = requireEnv("APP_DB_USER");
  const appPassword = requireEnv("APP_DB_PASSWORD");

  const name = `${PREFIX}${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: withDatabase(ownerUrl, "postgres") });
  await admin.connect();
  await admin.query(`create database "${name}"`);

  const testOwnerUrl = withDatabase(ownerUrl, name);
  try {
    runMigrations(testOwnerUrl);
    await ensureAppRole(testOwnerUrl, { user: appUser, password: appPassword });
  } catch (error) {
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
    throw error;
  }

  const appUrl = new URL(testOwnerUrl);
  appUrl.username = appUser;
  appUrl.password = appPassword;
  project.provide("testDatabase", { ownerUrl: testOwnerUrl, appUrl: appUrl.toString() });

  return async () => {
    // Only ever drop the database this run created.
    if (name.startsWith(PREFIX)) {
      await admin.query(`drop database if exists "${name}" with (force)`);
    }
    await admin.end();
  };
}
