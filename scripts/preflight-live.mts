import path from "node:path";
import {
  evaluatePreflight,
  hasFailures,
  newestBackupAgeHours,
  readDatabaseFacts,
  type Level,
} from "@/features/preflight/live-readiness";
import { ConfigError, getServerConfig } from "@/lib/config";
import { getDb } from "@/lib/db";

/**
 * A pre-flight checklist for the first real bank link.
 *
 *   docker compose exec app npm run preflight
 *
 * Read-only: it changes nothing and contacts no one (not Plaid, not a bank). It
 * prints what it can verify from here and lists what only you can check. It works
 * in Sandbox too, where problems show as warnings ("needed before going live").
 * Exits non-zero if something would block going live.
 */

const MARK: Record<Level, string> = { PASS: "PASS  ", WARN: "WARN  ", FAIL: "FAIL  ", INFO: "info  ", MANUAL: "check " };

async function main() {
  let config;
  try {
    config = getServerConfig();
  } catch (error) {
    // The message names the setting, never its value.
    console.log(`FAIL  Configuration is not valid: ${error instanceof ConfigError ? error.message : "unknown problem"}`);
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  try {
    const results = evaluatePreflight({
      plaidEnv: config.plaidEnv,
      plaidConfigured: config.plaid !== null,
      appUrl: config.appUrl,
      redirectUri: config.plaidRedirectUri,
      retiredKeyCount: config.tokenEncryption.retired.length,
      database: await readDatabaseFacts(db),
      // The repository folder is mounted into the container, so ./backups is visible.
      newestBackupAgeHours: await newestBackupAgeHours(path.resolve("backups")),
    });

    console.log(`Pre-flight for ${config.plaidEnv === "production" ? "PRODUCTION (real banks)" : "Sandbox"}\n`);
    for (const r of results) console.log(`${MARK[r.level]}${r.title}\n        ${r.detail}`);

    const counts = (level: Level) => results.filter((r) => r.level === level).length;
    console.log(`\n${counts("FAIL")} failing, ${counts("WARN")} warnings, ${counts("MANUAL")} things only you can check.`);
    if (hasFailures(results)) {
      console.log("Fix the failing items before linking a real bank.");
      process.exitCode = 1;
    } else if (config.plaidEnv === "sandbox") {
      console.log("Sandbox mode: warnings above are what going live would still need.");
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Deliberately terse: nothing here should echo a connection string or a key.
  console.error(`Error: the pre-flight check could not run (${error instanceof Error ? error.name : "unknown"}). Is the database up?`);
  process.exitCode = 1;
});
