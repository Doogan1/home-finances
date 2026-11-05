// Restores a backup. By default into a NEW, separate database; the live database
// is never touched unless you ask for that explicitly.
//
//   npm run restore -- backups\home-finances-home_finances-20261103T120000Z.dump
//   npm run restore -- <file> --target my_restore_test
//   npm run restore -- <file> --replace-live --confirm home_finances      (stop the app first)
//
// Runs on the host; needs Docker Desktop with the stack up.

import {
  BackupError,
  differences,
  fingerprintDatabase,
  liveDatabaseInfo,
  restoreBackup,
} from "./lib/backup.mjs";

const args = process.argv.slice(2);
const options = { file: undefined, target: undefined, replaceLive: false, confirm: undefined };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--target" && args[i + 1]) options.target = args[++i];
  else if (arg === "--confirm" && args[i + 1]) options.confirm = args[++i];
  else if (arg === "--replace-live") options.replaceLive = true;
  else if (!arg.startsWith("--") && !options.file) options.file = arg;
  else {
    console.error("Usage: npm run restore -- <dump file> [--target <new database>] [--replace-live --confirm <live database>]");
    process.exit(1);
  }
}

try {
  const result = await restoreBackup(options);
  if (result.replacedLive) {
    console.log(`The live database "${result.database}" was replaced from the backup.`);
    console.log(`The database you had before is still there as "${result.previousDatabase}" (an instant way back). Drop it when you are satisfied:`);
    console.log(`  docker compose exec db sh -c 'dropdb -U "$POSTGRES_USER" ${result.previousDatabase}'`);
    console.log("Start the app again with `docker compose start app`. Everyone must sign in again (sessions are not backed up).");
  } else {
    console.log(`Restored into a separate database: ${result.database}`);
    const fingerprint = await fingerprintDatabase(result.database);
    for (const [table, { count }] of Object.entries(fingerprint)) console.log(`  ${table.padEnd(18)} ${String(count).padStart(7)} rows`);
    const live = await liveDatabaseInfo();
    const changed = differences(await fingerprintDatabase(live.database), fingerprint);
    console.log(
      changed.length === 0
        ? "\nIts content is identical to the live database."
        : `\nDiffers from the live database in: ${changed.join(", ")}` +
          (changed.join() === "LinkAttempt"
            ? " (link attempts no longer point at the sessions that started them; sessions are not backed up, so this is expected)."
            : " (expected if the backup is older than the live data)."),
    );
    console.log(`\nThe live database was not touched. Remove this copy when done:`);
    console.log(`  docker compose exec db sh -c 'dropdb -U "$POSTGRES_USER" ${result.database}'`);
  }
} catch (error) {
  console.error(`Restore failed: ${error instanceof BackupError ? error.message : "unexpected error"}`);
  process.exit(1);
}
