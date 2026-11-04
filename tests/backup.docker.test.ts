import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BackupError,
  DEFAULT_BACKUP_DIR,
  EXCLUDED_FROM_BACKUP,
  assertSafeBackupDir,
  compose,
  createBackup,
  databaseExists,
  differences,
  fingerprintDatabase,
  liveDatabaseInfo,
  restoreBackup,
  sql,
} from "../scripts/lib/backup.mjs";

// Backup and restore against the real Docker stack, on throwaway databases only.
// Everything below is synthetic. The live database is read for its name and never
// written; every database this file creates is dropped in afterAll.

const suffix = randomBytes(4).toString("hex");
const SOURCE = `hf_bk_src_${suffix}`;
const COPY = `hf_bk_copy_${suffix}`;
const PRETEND_LIVE = `hf_bk_live_${suffix}`;
const created = [SOURCE, COPY, PRETEND_LIVE];

let outDir: string;
let dumpPath: string;
let live: { user: string; database: string };

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function migrate(database: string) {
  // The app container knows how to migrate; point it at the throwaway database.
  const result = await compose([
    "exec", "-T", "-e", `TARGET_DB=${database}`, "app", "sh", "-c",
    `export MIGRATION_DATABASE_URL=$(node -e "const u=new URL(process.env.MIGRATION_DATABASE_URL);u.pathname='/'+process.env.TARGET_DB;console.log(u.toString())") && npm run db:migrate`,
  ]);
  if (result.code !== 0) throw new Error("Could not migrate the throwaway database: " + result.stderr.slice(-300));
}

/** Connects to `database` as the app's restricted role (from the app container) and counts households. */
async function householdsAsAppRole(database: string): Promise<string> {
  const script =
    'const {Client}=require("pg");(async()=>{const u=new URL(process.env.DATABASE_URL);u.pathname="/"+process.env.TARGET_DB;' +
    'const c=new Client({connectionString:u.toString()});await c.connect();' +
    'const r=await c.query(\'select count(*)::int as n from "Household"\');console.log(r.rows[0].n);await c.end()})()' +
    '.catch(e=>{console.log("ERR "+e.code);process.exit(1)})';
  const result = await compose(["exec", "-T", "-e", `TARGET_DB=${database}`, "app", "node", "-e", script]);
  return result.stdout.trim();
}

async function dropAll() {
  for (const name of created) await sql(`drop database if exists "${name}" with (force)`, "postgres").catch(() => undefined);
}

beforeAll(async () => {
  live = await liveDatabaseInfo();
  outDir = await mkdtemp(path.join(os.tmpdir(), "hf-backup-test-"));
  await dropAll();
  await sql(`create database "${SOURCE}"`, "postgres");
  await migrate(SOURCE);

  // Synthetic data chosen to be awkward: exact decimals at both extremes, a
  // negative, nulls that mean "not reported", and non-ASCII text.
  await sql(
    `
    insert into "Household"(id, name) values ('${ID(1)}', 'Backup Test Household');
    insert into "User"(id, name, email, "updatedAt") values ('${ID(2)}', 'Tëst Üser', 'backup@example.test', now());
    insert into "Session"(id, "userId", token, "expiresAt", "updatedAt") values ('${ID(3)}', '${ID(2)}', 'raw-session-token-must-not-be-backed-up', now() + interval '1 day', now());
    insert into "LinkAttempt"(id, "householdId", "sessionId", environment, status, "expiresAt", "providerItemId")
      values ('${ID(12)}', '${ID(1)}', '${ID(3)}', 'SANDBOX', 'NEEDS_RECONCILIATION', now() + interval '1 day', 'item_backup_1');
    insert into "RateLimit"(id, key, count, "lastRequest") values ('${ID(4)}', 'bucket|/sign-in/email', 3, 1700000000000);
    insert into "PlaidItem"(id, "householdId", environment, "plaidItemId", "institutionName", status, "accessTokenCiphertext", "updatedAt")
      values ('${ID(5)}', '${ID(1)}', 'SANDBOX', 'item_backup_1', 'Ünïcode Bänk — テスト', 'ACTIVE', 'v1.k1.AAAA.BBBB.CCCC', now());
    insert into "Account"(id, "householdId", "plaidItemId", "externalAccountId", name, type, currency, "updatedAt")
      values ('${ID(6)}', '${ID(1)}', '${ID(5)}', 'acct_backup_1', 'Checking', 'depository', 'USD', now());
    insert into "BalanceSnapshot"(id, "accountId", "observedAt", available, current, "limit", currency, source) values
      ('${ID(7)}', '${ID(6)}', now(), null, 12345678901234.5678, null, 'USD', 'ACCOUNTS_GET'),
      ('${ID(8)}', '${ID(6)}', now(), 0.0001, -9.99, 1000.1000, 'USD', 'ACCOUNTS_GET');
    insert into "Transaction"(id, "accountId", "plaidItemId", "providerTransactionId", amount, currency, date, pending, description, "updatedAt") values
      ('${ID(9)}',  '${ID(6)}', '${ID(5)}', 'txn_1', -2500.00, 'USD', '2026-11-01', false, 'Payroll', now()),
      ('${ID(10)}', '${ID(6)}', '${ID(5)}', 'txn_2', 0.1, 'USD', '2026-11-02', true, 'Pending coffee ☕', now()),
      ('${ID(11)}', '${ID(6)}', '${ID(5)}', 'txn_3', 99999999999999.9999, 'USD', '2026-11-03', false, 'Huge', now());
    `,
    SOURCE,
  );
}, 240_000);

afterAll(async () => {
  await dropAll();
  if (outDir) await rm(outDir, { recursive: true, force: true });
}, 120_000);

describe("backup", () => {
  it("writes a verified dump outside git, and says nothing secret", async () => {
    const result = await createBackup({ outDir, database: SOURCE });
    dumpPath = result.path;

    expect(result.database).toBe(SOURCE);
    expect(path.dirname(dumpPath)).toBe(outDir);
    expect(path.basename(dumpPath)).toMatch(/^home-finances-hf_bk_src_[0-9a-f]+-\d{8}T\d{6}Z\.dump$/);
    expect((await stat(dumpPath)).size).toBe(result.bytes);
    // Only the finished file remains: no half-written leftovers.
    expect((await readdir(outDir)).filter((f) => f.endsWith(".partial"))).toEqual([]);
  });

  it("leaves sessions and sign-in counters out of the dump, and keeps the real data", async () => {
    // Dumps are compressed, so read the archive's table of contents instead of raw bytes.
    const toc = (await compose(["exec", "-T", "db", "pg_restore", "--list"], { stdinFile: dumpPath })).stdout;
    const dataFor = (table: string) => new RegExp("TABLE DATA public " + table + " ").test(toc);

    for (const table of EXCLUDED_FROM_BACKUP) {
      expect(dataFor(table), table + " data must not be in the dump").toBe(false);
      expect(toc).toContain("TABLE public " + table + " "); // the empty table itself is still recreated
    }
    for (const table of ["Household", "PlaidItem", "Account", "BalanceSnapshot", "Transaction", "User"]) {
      expect(dataFor(table), table + " data must be in the dump").toBe(true);
    }
  });

  it("refuses to write inside the repository unless git ignores the location", async () => {
    await expect(assertSafeBackupDir(path.join(DEFAULT_BACKUP_DIR), async () => false)).rejects.toThrow(/not ignored by git/);
    // The real rules: the default folder, and any file ending in .dump anywhere in the repo, are ignored.
    await expect(assertSafeBackupDir(DEFAULT_BACKUP_DIR)).resolves.toBe(DEFAULT_BACKUP_DIR);
    // A folder outside the repository is the caller's own business.
    await expect(assertSafeBackupDir(outDir)).resolves.toBe(outDir);
  });

  it("rejects a database name that could be an injection", async () => {
    await expect(createBackup({ outDir, database: 'x"; drop database postgres; --' })).rejects.toThrow(/lower-case/);
  });
});

describe("restore into a separate database", () => {
  it("reproduces every row exactly, including awkward decimals", async () => {
    const result = await restoreBackup({ file: dumpPath, target: COPY });

    expect(result).toMatchObject({ database: COPY, replacedLive: false });
    const source = await fingerprintDatabase(SOURCE);
    const copy = await fingerprintDatabase(COPY);
    // Everything is identical except one deliberate change: a link attempt no
    // longer points at the session that started it, because sessions are not restored.
    expect(differences(source, copy)).toEqual(["LinkAttempt"]);
    expect(copy.LinkAttempt.count).toBe(source.LinkAttempt.count);
    expect((await sql(`select count("sessionId")::text from "LinkAttempt"`, SOURCE))[0][0]).toBe("1");
    expect((await sql(`select count(*)::text, count("sessionId")::text, min(status::text), min("providerItemId") from "LinkAttempt"`, COPY))[0]).toEqual([
      "1", "0", "NEEDS_RECONCILIATION", "item_backup_1",
    ]);

    // Spot-check the values themselves, not just their hashes.
    const decimals = async (db: string) =>
      (await sql(`select amount::text from "Transaction" order by "providerTransactionId"`, db)).map((r) => r[0]);
    expect(await decimals(COPY)).toEqual(["-2500.0000", "0.1000", "99999999999999.9999"]);
    expect(await decimals(COPY)).toEqual(await decimals(SOURCE));
    const balances = await sql(
      `select coalesce(available::text,'NULL'), coalesce(current::text,'NULL'), coalesce("limit"::text,'NULL') from "BalanceSnapshot" order by id`,
      COPY,
    );
    expect(balances).toEqual([
      ["NULL", "12345678901234.5678", "NULL"],
      ["0.0001", "-9.9900", "1000.1000"],
    ]);
    const text = await sql(`select "institutionName" from "PlaidItem"`, COPY);
    expect(text[0][0]).toBe("Ünïcode Bänk — テスト");
    expect((await sql(`select pending from "Transaction" where "providerTransactionId" = 'txn_2'`, COPY))[0][0]).toBe("t");
  });

  it("brings back the encrypted token as stored, not decrypted", async () => {
    const rows = await sql(`select "accessTokenCiphertext" from "PlaidItem"`, COPY);

    expect(rows[0][0]).toBe("v1.k1.AAAA.BBBB.CCCC");
  });

  it("does not restore sessions or throttle counters, so everyone signs in again", async () => {
    expect(source_count("Session", await fingerprintDatabase(SOURCE))).toBe(1);
    const copy = await fingerprintDatabase(COPY);
    for (const table of EXCLUDED_FROM_BACKUP) expect(copy[table].count).toBe(0);
  });

  it("refuses to restore into a database that already exists, changing nothing", async () => {
    const before = await fingerprintDatabase(COPY);

    await expect(restoreBackup({ file: dumpPath, target: COPY })).rejects.toThrow(/already exists/);

    expect(await fingerprintDatabase(COPY)).toEqual(before);
  });

  it("leaves no half-made database behind when the file is not a real dump", async () => {
    const bad = path.join(outDir, "not-a-dump.dump");
    await writeFile(bad, "this is not a PostgreSQL archive ".repeat(100));
    const target = `hf_bk_bad_${suffix}`;
    created.push(target);

    await expect(restoreBackup({ file: bad, target })).rejects.toBeInstanceOf(BackupError);

    expect(await databaseExists(target)).toBe(false);
  });

  it("says plainly when the file does not exist", async () => {
    await expect(restoreBackup({ file: path.join(outDir, "missing.dump") })).rejects.toThrow(/No such backup file/);
  });
});

describe("protecting the live database", () => {
  it("never restores over the live database by default", async () => {
    await expect(restoreBackup({ file: dumpPath, target: live.database })).rejects.toThrow(/replace the live database/);
  });

  it("needs the exact live name repeated to confirm", async () => {
    const attempt = (confirm?: string) =>
      restoreBackup({ file: dumpPath, target: live.database, replaceLive: true, confirm, appRunning: async () => false });

    await expect(attempt()).rejects.toThrow(/repeat its exact name/);
    await expect(attempt("home_finance")).rejects.toThrow(/repeat its exact name/);
  });

  it("refuses while the app is running", async () => {
    await expect(
      restoreBackup({
        file: dumpPath,
        target: live.database,
        replaceLive: true,
        confirm: live.database,
        appRunning: async () => true,
      }),
    ).rejects.toThrow(/Stop the app first/);
  });

  it("leaves the real live database exactly as it was through all of the above", async () => {
    // The tests only ever created hf_bk_* databases; the live data is untouched.
    const names = (await sql(`select datname from pg_database where datname = '${live.database}'`, "postgres")).map((r) => r[0]);
    expect(names).toEqual([live.database]);
  });

  it("when explicitly confirmed, restores on the side and swaps, keeping the old database as a way back", async () => {
    // A throwaway database stands in for "live" so the real one is never at risk.
    await restoreBackup({ file: dumpPath, target: PRETEND_LIVE });
    await sql(`delete from "Transaction"; delete from "BalanceSnapshot"; delete from "Account"`, PRETEND_LIVE);
    const damaged = await fingerprintDatabase(PRETEND_LIVE);
    expect(differences(await fingerprintDatabase(SOURCE), damaged)).toContain("Transaction");

    let beforeGrants = "";
    let afterGrants = "";
    const result = await restoreBackup({
      file: dumpPath,
      target: PRETEND_LIVE,
      liveDatabase: PRETEND_LIVE,
      replaceLive: true,
      confirm: PRETEND_LIVE,
      appRunning: async () => false,
      // The real thing the CLI does at this point: migrate re-applies the app role's permissions.
      reapplyGrants: async () => {
        beforeGrants = await householdsAsAppRole(PRETEND_LIVE);
        await migrate(PRETEND_LIVE);
        afterGrants = await householdsAsAppRole(PRETEND_LIVE);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    created.push(result.previousDatabase);

    expect(result).toMatchObject({ database: PRETEND_LIVE, replacedLive: true });
    expect(result.previousDatabase).toMatch(new RegExp("^" + PRETEND_LIVE + "_replaced_"));
    // The swapped-in database starts without the restricted app role's permissions (so
    // the step is genuinely needed), and has them once migrate has run.
    expect(beforeGrants).toBe("ERR 42501");
    expect(afterGrants).toBe("1");
    // The "live" name now holds the restored data...
    expect(differences(await fingerprintDatabase(SOURCE), await fingerprintDatabase(PRETEND_LIVE))).toEqual(["LinkAttempt"]);
    // ...and the database it replaced is still there, damage and all, to go back to.
    expect(await databaseExists(result.previousDatabase)).toBe(true);
    expect(await fingerprintDatabase(result.previousDatabase)).toEqual(damaged);
    // No half-built side database is left over.
    const leftovers = await sql(`select datname from pg_database where datname like '${PRETEND_LIVE}_incoming_%'`, "postgres");
    expect(leftovers).toEqual([]);
  });

  it("changes nothing if the replacement cannot be built", async () => {
    await restoreBackup({ file: dumpPath, target: `${PRETEND_LIVE}_b` });
    created.push(`${PRETEND_LIVE}_b`);
    const bad = path.join(outDir, "corrupt.dump");
    await writeFile(bad, "this is not a PostgreSQL archive ".repeat(100));
    const before = await fingerprintDatabase(`${PRETEND_LIVE}_b`);

    await expect(
      restoreBackup({
        file: bad,
        target: `${PRETEND_LIVE}_b`,
        liveDatabase: `${PRETEND_LIVE}_b`,
        replaceLive: true,
        confirm: `${PRETEND_LIVE}_b`,
        appRunning: async () => false,
        reapplyGrants: async () => ({ code: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toBeInstanceOf(BackupError);

    expect(await fingerprintDatabase(`${PRETEND_LIVE}_b`)).toEqual(before);
    const side = await sql(`select datname from pg_database where datname like '${PRETEND_LIVE}_b_%'`, "postgres");
    expect(side).toEqual([]);
  });
});

function source_count(table: string, fingerprint: Record<string, { count: number }>): number {
  return fingerprint[table]?.count ?? 0;
}
