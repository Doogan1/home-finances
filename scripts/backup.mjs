// Writes a verified backup of the live database to ./backups (or --out <folder>).
//
//   npm run backup
//   npm run backup -- --out D:\private\finance-backups
//
// Runs on the host; needs Docker Desktop with the stack up. See
// docs/local-development.md ("Backups") before relying on it.

import { BackupError, EXCLUDED_FROM_BACKUP, createBackup } from "./lib/backup.mjs";

const args = process.argv.slice(2);
let outDir;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) outDir = args[++i];
  else {
    console.error("Usage: npm run backup [-- --out <folder>]");
    process.exit(1);
  }
}

try {
  const result = await createBackup({ outDir });
  const mb = (result.bytes / 1024 / 1024).toFixed(2);
  console.log(`Backup written and verified: ${result.path}  (${mb} MB)`);
  console.log("");
  console.log("This file is SENSITIVE and is NOT encrypted:");
  console.log("  - it holds your accounts, balances and transactions, password hashes and ENCRYPTED bank tokens;");
  console.log("  - it does NOT include TOKEN_ENCRYPTION_KEY. Back that up separately: without the key the tokens are");
  console.log("    unreadable (you would reconnect the banks); WITH the key a copy of this file is dangerous;");
  console.log(`  - sessions and sign-in counters (${EXCLUDED_FROM_BACKUP.join(", ")}) are left out on purpose.`);
  console.log("It lives only on this machine, so it is not protection against losing the machine.");
} catch (error) {
  console.error(`Backup failed: ${error instanceof BackupError ? error.message : "unexpected error"}`);
  process.exit(1);
}
