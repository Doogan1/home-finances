// Copies new encrypted backups from the server to this PC, and warns when the
// newest is more than 36 hours old (the nightly backup may have stopped).
//
//   npm run backup:pull                    into backups/homelab (git-ignored)
//   npm run backup:pull -- --out <folder>
//
// The copies stay encrypted; only the age identity on this PC can open them.
// Exit codes: 0 fine, 1 failed, 2 copied but the newest backup is stale.

import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BACKUP_DIR, assertSafeBackupDir } from "./lib/backup.mjs";
import { newestBackupAgeHours, parseBackupName } from "./lib/retention.mjs";

const HOST = process.env.HF_DEPLOY_HOST || "homelab";
const STALE_HOURS = 36;
const args = process.argv.slice(2);
let outDir = path.join(DEFAULT_BACKUP_DIR, "homelab");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) outDir = args[++i];
  else {
    console.error("Usage: npm run backup:pull [-- --out <folder>]");
    process.exit(1);
  }
}

function run(command, commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (error) => resolve({ code: 1, out: error.message }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const dir = await assertSafeBackupDir(outDir);
await mkdir(dir, { recursive: true });

const listing = await run("ssh", [HOST, "ls -1 home-finances/backups"]);
if (listing.code !== 0) {
  console.error(`Could not list the server's backups: ${listing.out.trim()}`);
  process.exit(1);
}
const remote = listing.out.split("\n").map((l) => l.trim()).filter((n) => parseBackupName(n) !== null);
const local = new Set(await readdir(dir));

let copied = 0;
for (const name of remote.filter((n) => !local.has(n))) {
  const partial = path.join(dir, `${name}.partial`);
  const result = await run("scp", ["-q", `${HOST}:home-finances/backups/${name}`, partial]);
  if (result.code !== 0) {
    await rm(partial, { force: true });
    console.error(`Could not copy ${name}: ${result.out.trim()}`);
    process.exit(1);
  }
  await rename(partial, path.join(dir, name));
  copied++;
}
console.log(`Copied ${copied} new backup(s) into ${dir}.`);

const age = newestBackupAgeHours(remote, new Date());
if (age === null || age > STALE_HOURS) {
  console.error(
    age === null
      ? "WARNING: the server has no backups at all."
      : `WARNING: the newest backup on the server is ${Math.round(age)} hours old. Check: ssh ${HOST} systemctl --user status home-finances-backup`,
  );
  process.exit(2);
}
