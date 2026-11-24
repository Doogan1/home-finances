import "server-only";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * The checklist for "am I ready to link a real bank?". The rules are pure
 * functions over a snapshot of facts, so every situation is testable; the two
 * readers at the bottom gather those facts. The command that prints it is
 * `npm run preflight` (scripts/preflight-live.mts).
 *
 * It reports what it can see and lists, honestly, what only a person can check.
 * It never prints a secret, a key, or the credentials/query part of a URL.
 */

export type Level = "PASS" | "WARN" | "FAIL" | "INFO" | "MANUAL";
export type PreflightResult = { id: string; level: Level; title: string; detail: string };

export type PreflightInput = {
  plaidEnv: "sandbox" | "production";
  plaidConfigured: boolean;
  appUrl: string;
  redirectUri: string | null;
  retiredKeyCount: number;
  database: {
    /** Which Plaid environments the database already holds connections for. */
    environments: ("SANDBOX" | "PRODUCTION")[];
    /** Production connections ever created here, including disconnected ones. */
    productionItems: number;
    roleIsSuperuser: boolean;
  };
  /** Age of the newest backup file, or null if none could be found. */
  newestBackupAgeHours: number | null;
};

const REDIRECT_PATH = "/plaid/oauth";
const TRIAL_ITEM_LIMIT = 10; // per Plaid's billing page; confirm on your own dashboard
const STALE_BACKUP_HOURS = 24;

/** Origin and path only: never credentials, query strings or fragments. */
function safeParts(value: string): { origin: string; pathname: string; secure: boolean } | null {
  try {
    const url = new URL(value);
    return { origin: url.origin, pathname: url.pathname, secure: url.protocol === "https:" };
  } catch {
    return null;
  }
}

export function evaluatePreflight(input: PreflightInput): PreflightResult[] {
  const live = input.plaidEnv === "production";
  // Things that must be true before real banks, but are only advice while on Sandbox.
  const blocker: Level = live ? "FAIL" : "WARN";
  const note = (text: string) => (live ? text : `${text} (needed before going live)`);
  const results: PreflightResult[] = [];
  const add = (id: string, level: Level, title: string, detail: string) => results.push({ id, level, title, detail });

  add(
    "mode",
    live ? "PASS" : "INFO",
    live ? "Production mode, deliberately opted in" : "Sandbox mode",
    live
      ? "PLAID_ENV=production with PLAID_LIVE_OPT_IN=yes. Real banks can be linked."
      : "Nothing real can be linked. The checks below show what going live would need.",
  );

  add(
    "credentials",
    input.plaidConfigured ? "PASS" : blocker,
    "Plaid credentials",
    input.plaidConfigured
      ? "A client id and secret are configured."
      : note("No Plaid credentials are configured, so banks cannot be connected. Set PLAID_CLIENT_ID and PLAID_SECRET for this environment."),
  );

  const app = safeParts(input.appUrl);
  // The address to register: always https (Plaid allows http only in Sandbox), on the app's own host.
  const httpsRedirect = `https://${(() => { try { return new URL(input.appUrl).host; } catch { return "<your app>"; } })()}${REDIRECT_PATH}`;
  add(
    "https",
    app?.secure ? "PASS" : blocker,
    "The app is served over https",
    app?.secure
      ? `APP_URL is ${app.origin}. Session cookies are marked Secure.`
      : note(
          "APP_URL is not https. The OAuth redirect page is part of this app, so it must be served over https (see docs/local-https.md).",
        ),
  );

  if (input.redirectUri === null) {
    add(
      "redirect-set",
      blocker,
      "OAuth redirect address",
      note("PLAID_REDIRECT_URI is not set. PNC and most large banks use OAuth, which needs a registered redirect address."),
    );
  } else {
    const redirect = safeParts(input.redirectUri);
    add("redirect-set", "PASS", "OAuth redirect address", `PLAID_REDIRECT_URI is set (${redirect ? redirect.origin + redirect.pathname : "unparseable"}).`);
    const expected = httpsRedirect;
    const matches = !!redirect && !!app && redirect.origin === app.origin && redirect.pathname === REDIRECT_PATH;
    add(
      "redirect-matches-app",
      matches ? "PASS" : blocker,
      "The redirect address is a page of this app",
      matches
        ? "It uses the same origin as APP_URL and the /plaid/oauth page."
        : note(`The redirect address must be exactly ${expected} so the bank sends you back to this app's own OAuth page.`),
    );
  }

  const envs = input.database.environments;
  if (live) {
    add(
      "separate-database",
      envs.includes("SANDBOX") ? "FAIL" : "PASS",
      "Real data is kept apart from Sandbox data",
      envs.includes("SANDBOX")
        ? "This database already holds Sandbox connections. Use a separate database (a separate Compose project, see docs/local-development.md, 'Going live') for real data."
        : "No Sandbox data is in this database.",
    );
  } else {
    add(
      "separate-database",
      envs.includes("PRODUCTION") ? "WARN" : "PASS",
      "Real data is kept apart from Sandbox data",
      envs.includes("PRODUCTION")
        ? "This Sandbox-mode database holds real (production) connections. Keep real and test data in separate databases."
        : "No real-bank data is in this database.",
    );
  }

  add(
    "restricted-role",
    input.database.roleIsSuperuser ? "FAIL" : "PASS",
    "The app uses a restricted database role",
    input.database.roleIsSuperuser
      ? "DATABASE_URL connects as a superuser. It must be the restricted app role (npm run db:migrate creates it)."
      : "The app role can read and write rows but cannot change the schema.",
  );

  const age = input.newestBackupAgeHours;
  add(
    "recent-backup",
    age === null ? blocker : age > STALE_BACKUP_HOURS ? "WARN" : "PASS",
    "A recent backup exists",
    age === null
      ? note("No backup file was found in ./backups. Run npm run backup, and try npm run restore, before the first real link.")
      : age > STALE_BACKUP_HOURS
        ? `The newest backup is ${Math.floor(age)} hours old. Take a fresh one (npm run backup) before linking.`
        : `The newest backup is ${Math.max(0, Math.floor(age))} hours old.`,
  );

  add(
    "key-rotation",
    input.retiredKeyCount > 0 ? "WARN" : "PASS",
    "Encryption key",
    input.retiredKeyCount > 0
      ? "TOKEN_ENCRYPTION_RETIRED_KEYS is set, so a key rotation is unfinished. Finish it (npm run keys:rotate -- --apply) before adding real data."
      : "A single current key is in use.",
  );

  const used = input.database.productionItems;
  add(
    "trial-slots",
    used >= TRIAL_ITEM_LIMIT - 2 ? "WARN" : "INFO",
    "Trial connection allowance",
    `${used} production connection${used === 1 ? "" : "s"} created so far. Each uses one of the trial's Items, even after disconnecting (removing an Item does not free a slot). Plaid's billing page says the trial allows ${TRIAL_ITEM_LIMIT}; confirm the number on your own dashboard.`,
  );

  add("disk-encryption", "MANUAL", "Disk encryption is on", "Real data will sit in an unencrypted Docker volume and in unencrypted backup files. Confirm BitLocker (or equivalent) is on for this computer.");
  add("cloud-sync", "MANUAL", "Secrets are not synced to a cloud", "Make sure .env, backups/ and certs/ are not inside a folder that OneDrive, Google Drive or similar uploads.");
  add("key-backup", "MANUAL", "The encryption key is backed up, separately", "TOKEN_ENCRYPTION_KEY saved in a password manager, apart from any database backup. Use a DIFFERENT key for real data than for Sandbox.");
  add("dashboard-redirect", "MANUAL", "Redirect address registered in Plaid", `Add exactly ${httpsRedirect} to the allowed redirect URIs in the Plaid Dashboard.`);
  add("dashboard-institution", "MANUAL", "Production access and the bank", "On the Dashboard: Production (trial) access is enabled for Transactions, and the bank (for example PNC) shows as available on the OAuth institutions page.");
  add("account-selection", "MANUAL", "Choose every account the first time", "Select all the accounts you want when you first link a bank. To change them later use 'Add or change accounts' on the Connections page; linking the same bank again uses another trial slot and, at PNC, invalidates the first connection.");

  return results;
}

export function hasFailures(results: PreflightResult[]): boolean {
  return results.some((r) => r.level === "FAIL");
}

// ---------------------------------------------------------------------------
// Fact gathering
// ---------------------------------------------------------------------------

/** What the database already holds, and whether the app is connected as a superuser. */
export async function readDatabaseFacts(db: PrismaClient): Promise<PreflightInput["database"]> {
  const groups = await db.plaidItem.groupBy({ by: ["environment"], _count: { _all: true } });
  const roles = await db.$queryRaw<{ rolsuper: boolean }[]>`select rolsuper from pg_roles where rolname = current_user`;
  return {
    environments: groups.map((g) => g.environment),
    productionItems: groups.find((g) => g.environment === "PRODUCTION")?._count._all ?? 0,
    roleIsSuperuser: roles[0]?.rolsuper ?? false,
  };
}

/** Age in hours of the newest `*.dump` in `dir`, or null if there is none (or no such folder). */
export async function newestBackupAgeHours(dir: string, now: Date = new Date()): Promise<number | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const name of names.filter((n) => n.endsWith(".dump"))) {
    const modified = (await stat(path.join(dir, name))).mtimeMs;
    if (newest === null || modified > newest) newest = modified;
  }
  return newest === null ? null : (now.getTime() - newest) / 3_600_000;
}

const USAGE = "Usage: npm run preflight [-- --backup-age-hours <whole hours>]";

/**
 * `--backup-age-hours <n>` says how old the newest backup is. On the homelab
 * server the backups are on the host, not in the container that runs this, so
 * `hf preflight` works the age out there and passes it in.
 */
export function parsePreflightArgs(argv: readonly string[]): { backupAgeHours?: number } {
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== "--backup-age-hours" || !/^\d{1,6}$/.test(argv[1])) throw new Error(USAGE);
  return { backupAgeHours: Number(argv[1]) };
}
