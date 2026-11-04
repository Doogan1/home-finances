import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { TokenCryptoError, plaidItemTokenContext, tokenKeyId } from "@/lib/crypto/tokens";
import type { TokenVault } from "./types";

/**
 * Re-encrypts every stored Plaid access token under the current key, so an old
 * key can be retired without losing any connection. See the key-rotation steps
 * in docs/local-development.md.
 *
 * Safe by construction:
 *  - dry run by default; nothing is written unless `apply` is set;
 *  - each token is decrypted and re-encrypted in memory and written back only if
 *    the stored value is still exactly what was read (compare-and-set), so a
 *    concurrent change is never overwritten;
 *  - a token that cannot be read is left untouched and reported by id;
 *  - the report holds counts and row ids only, never a token, ciphertext or key;
 *  - running it again is harmless (tokens already on the current key are skipped).
 */

export type RotationReport = {
  dryRun: boolean;
  examined: number;
  alreadyCurrent: number;
  /** Tokens re-encrypted (or, in a dry run, that would be). */
  rotated: number;
  /** Row ids whose token could not be decrypted with any configured key. */
  unreadable: string[];
  /** Rows that changed while rotating; run again to pick them up. */
  changedConcurrently: number;
};

export async function rotateTokenKeys(
  deps: { db: PrismaClient; tokens: TokenVault; currentKeyId: string },
  options: { apply: boolean; batchSize?: number },
): Promise<RotationReport> {
  const { db, tokens, currentKeyId } = deps;
  const batchSize = options.batchSize ?? 100;
  const report: RotationReport = {
    dryRun: !options.apply,
    examined: 0,
    alreadyCurrent: 0,
    rotated: 0,
    unreadable: [],
    changedConcurrently: 0,
  };

  let after: string | undefined;
  for (;;) {
    const rows = await db.plaidItem.findMany({
      where: { accessTokenCiphertext: { not: null } },
      select: { id: true, environment: true, plaidItemId: true, accessTokenCiphertext: true },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    for (const row of rows) {
      const stored = row.accessTokenCiphertext as string;
      report.examined += 1;
      if (tokenKeyId(stored) === currentKeyId) {
        report.alreadyCurrent += 1;
        continue;
      }

      const context = plaidItemTokenContext(row.environment, row.plaidItemId);
      let replacement: string;
      try {
        const plaintext = tokens.decrypt(stored, context);
        replacement = tokens.encrypt(plaintext, context);
        // Prove the new ciphertext reads back before it can replace the old one.
        if (tokens.decrypt(replacement, context) !== plaintext) throw new TokenCryptoError("Round trip mismatch");
      } catch (error) {
        if (!(error instanceof TokenCryptoError)) throw error;
        report.unreadable.push(row.id);
        continue;
      }

      if (!options.apply) {
        report.rotated += 1;
        continue;
      }
      const written = await db.plaidItem.updateMany({
        where: { id: row.id, accessTokenCiphertext: stored },
        data: { accessTokenCiphertext: replacement },
      });
      if (written.count === 1) report.rotated += 1;
      else report.changedConcurrently += 1;
    }
    if (rows.length < batchSize) break;
  }
  return report;
}
