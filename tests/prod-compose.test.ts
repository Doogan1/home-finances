import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Service = {
  image?: string;
  build?: { context: string; target: string };
  profiles?: string[];
  ports?: string[];
  environment?: Record<string, string>;
  command?: string[];
  volumes?: string[];
};
const compose = parse(readFileSync("compose.prod.yaml", "utf8")) as { services: Record<string, Service> };
const { app, db, migrate } = compose.services;

const APP_ENV = [
  "APP_URL",
  "AUTH_SECRET",
  "DATABASE_URL",
  "PLAID_CLIENT_ID",
  "PLAID_ENV",
  "PLAID_LIVE_OPT_IN",
  "PLAID_REDIRECT_URI",
  "PLAID_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "TOKEN_ENCRYPTION_KEY_ID",
  "TOKEN_ENCRYPTION_RETIRED_KEYS",
];

describe("compose.prod.yaml", () => {
  it("has exactly the database, the one-off migrate job and the app", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["app", "db", "migrate"]);
  });

  it("gives the app only what it reads, never the owner credentials", () => {
    expect(Object.keys(app.environment ?? {}).sort()).toEqual(APP_ENV);
    expect(JSON.stringify(app)).not.toMatch(/MIGRATION_DATABASE_URL|POSTGRES_|APP_DB_PASSWORD|env_file/);
  });

  it("publishes the app on loopback only, and the database not at all", () => {
    expect(app.ports).toEqual(["127.0.0.1:3000:3000"]);
    expect(db.ports).toBeUndefined();
    expect(migrate.ports).toBeUndefined();
  });

  it("builds the production and tools targets, tagged by release", () => {
    expect(app.build).toEqual({ context: ".", target: "production" });
    expect(app.image).toBe("home-finances:${RELEASE:?set by deploy/server/env.sh}");
    expect(migrate.build).toEqual({ context: ".", target: "tools" });
    expect(migrate.image).toBe("home-finances-tools:${RELEASE:?set by deploy/server/env.sh}");
  });

  it("runs migrations only when asked, with the owner credentials", () => {
    expect(migrate.profiles).toEqual(["ops"]);
    expect(Object.keys(migrate.environment ?? {}).sort()).toEqual(["APP_DB_PASSWORD", "APP_DB_USER", "MIGRATION_DATABASE_URL"]);
  });

  it("mounts no host folders, so SELinux labels never matter", () => {
    for (const service of [app, db, migrate]) {
      for (const volume of service.volumes ?? []) expect(volume).not.toMatch(/^[./~]/);
    }
  });
});
