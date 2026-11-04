import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getServerConfig } from "@/lib/config";

/**
 * Authenticated encryption for secrets stored in the database (Plaid access
 * tokens). All other code must go through this module and never touch crypto
 * primitives directly.
 *
 * Stored format (dot-separated, base64url without padding for binary parts):
 *
 *   v1.<keyId>.<nonce>.<ciphertext>.<authTag>
 *
 * AES-256-GCM with a fresh random 96-bit nonce per encryption. The version, key
 * id and caller-supplied context are bound in as additional authenticated data,
 * so a ciphertext cannot be moved to another Item/environment, relabelled with a
 * different key id, or downgraded to another version without failing
 * authentication. The key itself lives outside the database.
 */

const VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Deliberately generic: messages never contain tokens, ciphertext or keys. */
export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

export type TokenCipherKey = { keyId: string; key: Buffer };

export type TokenCipherKeys = {
  /** Used for every new encryption. */
  current: TokenCipherKey;
  /** Retired keys that may still decrypt older data during/after rotation. */
  retired?: TokenCipherKey[];
};

export type TokenCipher = {
  encryptToken(token: string, context: string): string;
  decryptToken(ciphertext: string, context: string): string;
};

function validateKey({ keyId, key }: TokenCipherKey): void {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new TokenCryptoError("Invalid token encryption key id");
  }
  if (key.length !== KEY_BYTES) {
    throw new TokenCryptoError("Invalid token encryption key length");
  }
}

function additionalData(keyId: string, context: string): Buffer {
  // NUL cannot appear in the key id, so the fields cannot be shifted around.
  return Buffer.from(`${VERSION}\0${keyId}\0${context}`, "utf8");
}

/** Decode strict, canonical, unpadded base64url; null for anything else. */
function decodeBase64Url(value: string): Buffer | null {
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

export function createTokenCipher(keys: TokenCipherKeys): TokenCipher {
  const all = [keys.current, ...(keys.retired ?? [])];
  all.forEach(validateKey);
  const byId = new Map(all.map((entry) => [entry.keyId, entry.key]));
  if (byId.size !== all.length) {
    throw new TokenCryptoError("Duplicate token encryption key id");
  }
  const { current } = keys;

  return {
    encryptToken(token, context) {
      if (!token || !context) {
        throw new TokenCryptoError("Token and context are required");
      }
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", current.key, nonce, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(additionalData(current.keyId, context));
      const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();

      return [
        VERSION,
        current.keyId,
        nonce.toString("base64url"),
        ciphertext.toString("base64url"),
        tag.toString("base64url"),
      ].join(".");
    },

    decryptToken(stored, context) {
      const fail = () => new TokenCryptoError("Token could not be decrypted");
      if (!context) throw fail();

      const parts = stored.split(".");
      if (parts.length !== 5 || parts[0] !== VERSION) throw fail();

      const [, keyId, nonceText, ciphertextText, tagText] = parts;
      const key = byId.get(keyId);
      const nonce = decodeBase64Url(nonceText);
      const ciphertext = decodeBase64Url(ciphertextText);
      const tag = decodeBase64Url(tagText);
      if (!key || !nonce || !ciphertext || !tag) throw fail();
      if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw fail();

      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(additionalData(keyId, context));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        // Wrong key, wrong context, or tampering: never say which.
        throw fail();
      }
    },
  };
}

/**
 * Context for a Plaid access token: the immutable environment and Plaid Item
 * id. Binding both stops a token being replayed against another Item, or a
 * sandbox token being presented as a production one.
 */
export function plaidItemTokenContext(environment: string, plaidItemId: string): string {
  if (!environment || !plaidItemId) {
    throw new TokenCryptoError("Environment and item id are required");
  }
  // Length-prefix the environment so no item id can forge a different pair.
  return `plaid-item:${environment.length}:${environment}:${plaidItemId}`;
}

function configuredCipher(): TokenCipher {
  const { tokenEncryption } = getServerConfig();
  return createTokenCipher({
    current: { keyId: tokenEncryption.keyId, key: tokenEncryption.key },
    // Only for decrypting data not yet re-encrypted after a rotation.
    retired: tokenEncryption.retired,
  });
}

/**
 * The key id a stored token was encrypted under, or null if it is not in the
 * expected format. Reads the label only; nothing is decrypted or validated.
 */
export function tokenKeyId(stored: string): string | null {
  const parts = stored.split(".");
  return parts.length === 5 && parts[0] === VERSION && KEY_ID_PATTERN.test(parts[1]) ? parts[1] : null;
}

/** Encrypt with the configured key. `context` is e.g. `plaidItemTokenContext(...)`. */
export function encryptToken(token: string, context: string): string {
  return configuredCipher().encryptToken(token, context);
}

/** Decrypt with the configured key; throws TokenCryptoError on any failure. */
export function decryptToken(ciphertext: string, context: string): string {
  return configuredCipher().decryptToken(ciphertext, context);
}
