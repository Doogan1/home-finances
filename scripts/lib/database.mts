import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { Client } from "pg";

const require = createRequire(import.meta.url);

/** Same server and credentials, different database name. */
export function withDatabase(connectionUrl: string, database: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Apply committed migrations. Never creates new ones and never resets data. */
export function runMigrations(ownerUrl: string): void {
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl },
    stdio: "inherit",
  });
}

/**
 * Create (or update) the restricted role the running app connects as, and give
 * it data access to the tables in the database `ownerUrl` points at.
 *
 * The role can read and write rows. It cannot create or alter tables, create
 * databases or roles, or read Prisma's migration history, so a bug or injection
 * through the app's connection cannot change the schema. Safe to re-run; run it
 * after every migration so newly created tables are covered.
 */
export async function ensureAppRole(
  ownerUrl: string,
  app: { user: string; password: string },
): Promise<void> {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();

  // Identifiers and literals are quoted by PostgreSQL's own format(), never by
  // string concatenation here.
  const run = async (template: string, ...args: string[]) => {
    const placeholders = args.map((_, i) => `, $${i + 2}::text`).join("");
    const { rows } = await client.query<{ sql: string }>(
      `select format($1${placeholders}) as sql`,
      [template, ...args],
    );
    await client.query(rows[0].sql);
  };

  try {
    const { rows } = await client.query<{ db: string; exists: boolean }>(
      `select current_database() as db,
              exists(select 1 from pg_roles where rolname = $1) as exists`,
      [app.user],
    );
    const { db, exists } = rows[0];
    const attributes = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";

    await run(`${exists ? "ALTER" : "CREATE"} ROLE %I ${attributes} PASSWORD %L`, app.user, app.password);
    await run("GRANT CONNECT ON DATABASE %I TO %I", db, app.user);
    await run("GRANT USAGE ON SCHEMA public TO %I", app.user);
    await run("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I", app.user);
    await run("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I", app.user);
    // Tables created by future migrations (run by this owner role) get the same rights.
    await run(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I",
      app.user,
    );
    await run(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I",
      app.user,
    );
    await client.query(`do $$ begin
      if to_regclass('public._prisma_migrations') is not null then
        execute format('revoke all on table public._prisma_migrations from %I', ${quoteLiteral(app.user)});
      end if;
    end $$`);
  } finally {
    await client.end();
  }
}

// Used only to embed the role name inside the DO block above.
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
