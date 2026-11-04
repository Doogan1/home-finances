import { rotateTokenKeys } from "@/features/plaid/key-rotation";
import { getServerConfig } from "@/lib/config";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";
import { getDb } from "@/lib/db";

/**
 * Re-encrypts stored Plaid access tokens under the current TOKEN_ENCRYPTION_KEY.
 *
 *   docker compose exec app npm run keys:rotate              -> dry run (changes nothing)
 *   docker compose exec app npm run keys:rotate -- --apply   -> do it
 *
 * Run it after putting the NEW key in TOKEN_ENCRYPTION_KEY and the OLD one in
 * TOKEN_ENCRYPTION_RETIRED_KEYS (full steps: docs/local-development.md). It is
 * an operator tool for the whole database, not a web path. Output is counts and
 * row ids only.
 */

async function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--apply")) {
    console.error("Usage: keys:rotate [--apply]   (without --apply it only reports)");
    process.exitCode = 1;
    return;
  }
  const apply = args.includes("--apply");
  const { tokenEncryption } = getServerConfig();
  const db = getDb();
  try {
    const report = await rotateTokenKeys(
      { db, tokens: { encrypt: encryptToken, decrypt: decryptToken }, currentKeyId: tokenEncryption.keyId },
      { apply },
    );
    console.log(`Current key id: ${tokenEncryption.keyId}   Retired keys configured: ${tokenEncryption.retired.length}`);
    console.log(apply ? "Mode: APPLY" : "Mode: dry run (nothing was changed; add --apply to rotate)");
    console.log(`  tokens examined:          ${report.examined}`);
    console.log(`  already on current key:   ${report.alreadyCurrent}`);
    console.log(`  ${apply ? "re-encrypted:           " : "would be re-encrypted:  "}   ${report.rotated}`);
    console.log(`  changed while running:    ${report.changedConcurrently}${report.changedConcurrently ? "  (run again)" : ""}`);
    console.log(`  could not be decrypted:   ${report.unreadable.length}`);
    for (const id of report.unreadable) console.log(`    connection ${id}`);
    if (report.unreadable.length > 0) {
      console.log("\nUnreadable tokens need a key that is not configured. Add it to TOKEN_ENCRYPTION_RETIRED_KEYS,");
      console.log("or reconnect those banks. Do NOT remove the old key until this count is 0.");
      process.exitCode = 2;
    } else if (apply && report.changedConcurrently === 0) {
      console.log("\nAll tokens are on the current key. The retired key(s) can now be removed after you back up the new key.");
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Deliberately terse: never print anything that could contain a key or token.
  console.error(`Error: key rotation failed (${error instanceof Error ? error.name : "unknown"}). Check the key settings and database.`);
  process.exitCode = 1;
});
