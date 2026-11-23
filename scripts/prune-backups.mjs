// Applies the backup retention rule to a folder of encrypted backups.
//
//   node scripts/prune-backups.mjs <folder>            shows what would be deleted
//   node scripts/prune-backups.mjs <folder> --apply    deletes it
//
// Only finished `*.dump.age` backups are ever considered; see scripts/lib/retention.mjs.

import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { backupsToDelete } from "./lib/retention.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dirs = args.filter((a) => a !== "--apply");
if (dirs.length !== 1 || args.some((a) => a.startsWith("--") && a !== "--apply")) {
  console.error("Usage: node scripts/prune-backups.mjs <folder> [--apply]");
  process.exit(1);
}

const dir = path.resolve(dirs[0]);
const doomed = backupsToDelete(await readdir(dir), new Date());
if (doomed.length === 0) {
  console.log("Nothing to prune.");
} else {
  for (const name of doomed) {
    if (apply) await rm(path.join(dir, name));
    console.log(`${apply ? "Deleted" : "Would delete"} ${name}`);
  }
}
