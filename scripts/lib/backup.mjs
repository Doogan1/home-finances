// Backup and restore helpers for the local PostgreSQL container.
//
// These run on the HOST with plain Node (no build step, so they work from a
// Windows PowerShell as well as a shell) and drive `docker compose` to run
// pg_dump / pg_restore / psql inside the database container. Dumps are streamed
// straight to and from files, never through a shell redirection (which corrupts
// binary data on Windows).
//
// A dump is a sensitive local file: it holds your accounts, balances,
// transactions, password hashes and ENCRYPTED bank tokens. The encryption key is
// deliberately not part of it (back that up separately). Dumps are not encrypted
// and are not an off-machine backup.

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_BACKUP_DIR = path.join(REPO_ROOT, "backups");

/**
 * Tables whose DATA is left out of a dump. Sessions and throttle counters are
 * disposable (and raw session tokens should never sit in a backup); a restored
 * system simply asks everyone to sign in again.
 */
export const EXCLUDED_FROM_BACKUP = ["Session", "RateLimit", "Verification"];

const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupError";
  }
}

export function assertDatabaseName(name) {
  if (typeof name !== "string" || !DATABASE_NAME.test(name)) {
    throw new BackupError("Database names may only use lower-case letters, digits and underscores.");
  }
  return name;
}

// ---------------------------------------------------------------------------
// Running commands
// ---------------------------------------------------------------------------

/** Runs a command; optionally streams stdin from / stdout to files. Never uses a shell. */
function run(command, args, { cwd = REPO_ROOT, stdinFile, stdoutFile, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out = [];
    let err = "";
    child.on("error", (error) =>
      reject(new BackupError(`Could not run "${command}": ${error.message}. Is Docker Desktop running?`)),
    );
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });

    // When writing to a file, "finished" means the file is fully flushed to disk,
    // not merely that the process exited; a reader that started earlier would see
    // a truncated file.
    let fileWritten = Promise.resolve();
    if (stdoutFile) {
      const sink = createWriteStream(stdoutFile);
      fileWritten = new Promise((done, fail) => {
        sink.on("finish", done);
        sink.on("error", fail);
      });
      child.stdout.pipe(sink);
    } else {
      child.stdout.on("data", (chunk) => out.push(chunk));
    }

    if (stdinFile) {
      const source = createReadStream(stdinFile);
      source.on("error", (error) => {
        child.stdin.destroy();
        reject(new BackupError(`Could not read ${stdinFile}: ${error.message}`));
      });
      child.stdin.on("error", () => {}); // the command may stop reading early
      source.pipe(child.stdin);
    } else {
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
    }

    child.on("close", (code) => {
      fileWritten.then(
        () => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: err }),
        (error) => reject(new BackupError(`Could not write ${stdoutFile}: ${error.message}`)),
      );
    });
  });
}

function composeArgs(project, args) {
  return ["compose", ...(project ? ["-p", project] : []), ...args];
}

/** `docker compose ...` in the repo folder. */
export function compose(args, options = {}) {
  const { project, ...rest } = options;
  return run("docker", composeArgs(project, args), rest);
}

async function mustSucceed(result, what) {
  if (result.code !== 0) {
    const detail = result.stderr.trim().split("\n").slice(-3).join(" | ");
    throw new BackupError(`${what} failed${detail ? `: ${detail}` : "."}`);
  }
  return result;
}

/** The database service's owner role and live database name, read from the container. */
export async function liveDatabaseInfo(options = {}) {
  const result = await mustSucceed(
    await compose(["exec", "-T", "db", "sh", "-c", 'printf "%s\\n%s" "$POSTGRES_USER" "$POSTGRES_DB"'], options),
    "Reading the database settings (is the stack running? try `docker compose up -d`)",
  );
  const [user, database] = result.stdout.split("\n");
  if (!user || !database) throw new BackupError("The database container did not report its settings.");
  return { user, database };
}

/** Run SQL (from stdin) in `database` as the owner role; returns rows split on "|". */
export async function sql(statement, database, options = {}) {
  assertDatabaseName(database);
  const result = await mustSucceed(
    await compose(
      ["exec", "-T", "db", "sh", "-c", 'exec psql -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -At -F "|"', "sh", database],
      { ...options, input: statement },
    ),
    "A database query",
  );
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("|"));
}

export async function databaseExists(name, options = {}) {
  assertDatabaseName(name);
  const rows = await sql(`select 1 from pg_database where datname = '${name}'`, "postgres", options);
  return rows.length > 0;
}

async function ignoredByGit(file) {
  const result = await run("git", ["check-ignore", "-q", "--no-index", file]);
  // 0 = ignored, 1 = not ignored. Anything else (git missing, or this folder is
  // not a git repository, as with a downloaded ZIP) means there is no repository
  // a dump could be committed to, so there is nothing to protect against.
  return result.code !== 1;
}

// ---------------------------------------------------------------------------
// Where a dump may be written
// ---------------------------------------------------------------------------

/**
 * A dump must never end up in git. If the target folder is inside this
 * repository it must be ignored by git; otherwise (for example a folder outside
 * the repository) there is nothing to check.
 */
export async function assertSafeBackupDir(dir, isIgnored = ignoredByGit) {
  const resolved = path.resolve(dir);
  const relative = path.relative(REPO_ROOT, resolved);
  const insideRepo = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!insideRepo && relative !== "") return resolved;

  // A path inside the repo: ask git whether a dump written there would be ignored.
  if (!(await isIgnored(path.join(resolved, "probe.dump")))) {
    throw new BackupError(
      `Refusing to write backups to ${resolved}: it is inside the repository and not ignored by git. ` +
        "Use the default `backups/` folder or a folder outside the repository.",
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

function timestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * Writes a custom-format dump of `database` (default: the live one) to `outDir`
 * and checks that it can be read back. The file is created only when complete.
 */
export async function createBackup({ outDir = DEFAULT_BACKUP_DIR, database, project, prefix = "home-finances", now } = {}) {
  const live = await liveDatabaseInfo({ project });
  const name = assertDatabaseName(database ?? live.database);
  const dir = await assertSafeBackupDir(outDir);
  await mkdir(dir, { recursive: true });

  const finalPath = path.join(dir, `${prefix}-${name}-${timestamp(now)}.dump`);
  const partial = `${finalPath}.partial`;
  // Single-quoted so the shell passes the double quotes through to pg_dump,
  // which needs them to match these mixed-case table names exactly.
  const excludes = EXCLUDED_FROM_BACKUP.map((table) => `--exclude-table-data='public."${table}"'`).join(" ");

  try {
    await mustSucceed(
      await compose(
        [
          "exec", "-T", "db", "sh", "-c",
          `exec pg_dump -U "$POSTGRES_USER" -d "$1" --format=custom --no-owner --no-acl ${excludes}`,
          "sh", name,
        ],
        { project, stdoutFile: partial },
      ),
      "pg_dump",
    );
    const info = await stat(partial);
    if (info.size < 1024) throw new BackupError("The dump is suspiciously small; refusing to keep it.");

    // Prove the file is a readable archive before calling it a backup.
    const listing = await mustSucceed(
      await compose(["exec", "-T", "db", "pg_restore", "--list"], { project, stdinFile: partial }),
      "Verifying the dump",
    );
    if (!/PlaidItem/.test(listing.stdout)) {
      throw new BackupError("The dump does not contain the expected tables; refusing to keep it.");
    }

    await rename(partial, finalPath);
    try {
      await chmod(finalPath, 0o600); // no effect on Windows; owner-only elsewhere
    } catch {
      /* best effort */
    }
    return { path: finalPath, bytes: info.size, database: name };
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** Is the app service running? A live restore must not happen underneath it. */
export async function appIsRunning(options = {}) {
  const result = await mustSucceed(
    await compose(["ps", "--status", "running", "--services"], options),
    "Checking whether the app is running",
  );
  return result.stdout.split("\n").some((line) => line.trim() === "app");
}

/**
 * Loads a dump into a NEW database, in three steps because sessions are not in
 * the dump:
 *   1. tables and data               (one transaction)
 *   2. clear references to the missing sessions (a link attempt remembers which
 *      session started it; that session no longer exists, exactly as if the
 *      person had signed out)
 *   3. constraints and indexes       (one transaction)
 * On any failure the half-made database is dropped, so nothing is left behind.
 */
async function loadDump({ file, database, project }) {
  const opts = { project };
  const restore = (sections) =>
    compose(
      [
        "exec", "-T", "db", "sh", "-c",
        `exec pg_restore -U "$POSTGRES_USER" -d "$1" ${sections} --single-transaction --exit-on-error --no-owner --no-acl`,
        "sh", database,
      ],
      { ...opts, stdinFile: file },
    );

  await sql(`create database "${database}"`, "postgres", opts);
  try {
    await mustSucceed(await restore("--section=pre-data --section=data"), "Restoring the tables and data");
    await sql(`update "LinkAttempt" set "sessionId" = null where "sessionId" is not null`, database, opts);
    await mustSucceed(await restore("--section=post-data"), "Restoring the constraints and indexes");
  } catch (error) {
    await sql(`drop database if exists "${database}" with (force)`, "postgres", opts).catch(() => undefined);
    throw error;
  }
}

/**
 * Restores a dump. By default into a NEW, separate database (never the live
 * one). Replacing the live database needs `replaceLive`, a `confirm` that
 * repeats its exact name, and the app stopped. Even then nothing is overwritten
 * in place: the dump is first restored into a side database, and only if that
 * succeeds are the two swapped by renaming. The database you had stays, under
 * the name returned as `previousDatabase`, as an instant way back.
 */
export async function restoreBackup({
  file,
  target,
  replaceLive = false,
  confirm,
  project,
  liveDatabase,
  appRunning = () => appIsRunning({ project }),
  now = new Date(),
  reapplyGrants = () => compose(["run", "--rm", "--no-deps", "app", "npm", "run", "db:migrate"], { project }),
} = {}) {
  if (!file) throw new BackupError("Say which dump file to restore.");
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) throw new BackupError(`No such backup file: ${file}`);

  const live = liveDatabase ? { database: liveDatabase } : await liveDatabaseInfo({ project });
  const stamp = timestamp(now).toLowerCase();
  const targetName = assertDatabaseName(target ?? `${live.database}_restore_${stamp}`);
  const opts = { project };

  if (targetName !== live.database) {
    if (await databaseExists(targetName, opts)) {
      throw new BackupError(`A database named "${targetName}" already exists; choose another --target. Nothing was changed.`);
    }
    await loadDump({ file, database: targetName, project });
    return { database: targetName, replacedLive: false };
  }

  if (!replaceLive) {
    throw new BackupError(
      `That would replace the live database "${live.database}". Restore into a separate database ` +
        `(the default), or pass --replace-live and --confirm ${live.database} if you really mean it.`,
    );
  }
  if (confirm !== live.database) {
    throw new BackupError(`To replace the live database, repeat its exact name: --confirm ${live.database}`);
  }
  if (await appRunning()) {
    throw new BackupError("Stop the app first (`docker compose stop app`) so nothing writes while the database is replaced.");
  }

  const incoming = assertDatabaseName(`${live.database}_incoming_${stamp}`);
  const previous = assertDatabaseName(`${live.database}_replaced_${stamp}`);
  for (const name of [incoming, previous]) {
    if (await databaseExists(name, opts)) throw new BackupError(`"${name}" already exists; try again in a moment. Nothing was changed.`);
  }

  // 1. Build the replacement on the side. If this fails, the live database was never touched.
  await loadDump({ file, database: incoming, project });

  // 2. Swap by renaming, in one transaction. This fails (changing nothing) if anything is still connected.
  try {
    await sql(
      `begin; alter database "${live.database}" rename to "${previous}"; alter database "${incoming}" rename to "${live.database}"; commit;`,
      "postgres",
      opts,
    );
  } catch (error) {
    await sql(`drop database if exists "${incoming}" with (force)`, "postgres", opts).catch(() => undefined);
    throw new BackupError(
      "Could not swap the databases (is something still connected to it? try `docker compose stop app`). " +
        `Nothing was changed. ${error instanceof BackupError ? error.message : ""}`.trim(),
    );
  }

  // 3. The dump carries no grants (they come from configuration); re-apply them.
  await mustSucceed(
    await reapplyGrants(),
    `The data was restored, but re-applying the app database role's permissions failed. Run \`docker compose run --rm app npm run db:migrate\` yourself. Your previous database is still available as "${previous}"`,
  );
  return { database: live.database, replacedLive: true, previousDatabase: previous };
}

// ---------------------------------------------------------------------------
// Comparing databases
// ---------------------------------------------------------------------------

/**
 * A content fingerprint of every application table: row count plus an md5 over
 * the text of every row (numerics render as exact decimal text). Two databases
 * with equal fingerprints hold the same data.
 */
export async function fingerprintDatabase(database, options = {}) {
  const tables = (
    await sql(
      "select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations' order by 1",
      database,
      options,
    )
  ).map((row) => row[0]);
  if (tables.length === 0) return {};
  const query = tables
    .map(
      (t) =>
        `select '${t}', count(*), md5(coalesce(string_agg(r::text, E'\\n' order by r::text), '')) from "${t}" r`,
    )
    .join(" union all ");
  const rows = await sql(query, database, options);
  return Object.fromEntries(rows.map(([table, count, hash]) => [table, { count: Number(count), hash }]));
}

/** Tables whose count or content differs between two fingerprints, ignoring `skip`. */
export function differences(a, b, skip = EXCLUDED_FROM_BACKUP) {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...names]
    .filter((name) => !skip.includes(name))
    .filter((name) => a[name]?.count !== b[name]?.count || a[name]?.hash !== b[name]?.hash)
    .sort();
}
