import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TokenCryptoError,
  createTokenCipher,
  decryptToken,
  encryptToken,
  plaidItemTokenContext,
  tokenKeyId,
} from "@/lib/crypto/tokens";

// Synthetic keys and tokens only. Nothing here is a real credential.
const keyA = { keyId: "k1", key: Buffer.alloc(32, 1) };
const keyB = { keyId: "k1", key: Buffer.alloc(32, 2) };
const PLAINTEXT = "access-sandbox-0000-synthetic-token";
const CONTEXT = plaidItemTokenContext("sandbox", "item_abc123");

const cipher = createTokenCipher({ current: keyA });

/** Flip one character of a dot-separated part, keeping it valid base64url. */
function tamperPart(ciphertext: string, index: number): string {
  const parts = ciphertext.split(".");
  const original = parts[index];
  const replacement = original[0] === "A" ? "B" : "A";
  parts[index] = replacement + original.slice(1);
  return parts.join(".");
}

describe("token encryption", () => {
  it("round-trips a token", () => {
    const encrypted = cipher.encryptToken(PLAINTEXT, CONTEXT);

    expect(cipher.decryptToken(encrypted, CONTEXT)).toBe(PLAINTEXT);
  });

  it("round-trips unicode and long tokens", () => {
    const token = "tökén-✓-".repeat(500);

    expect(cipher.decryptToken(cipher.encryptToken(token, CONTEXT), CONTEXT)).toBe(token);
  });

  it("produces different ciphertext for the same plaintext", () => {
    const first = cipher.encryptToken(PLAINTEXT, CONTEXT);
    const second = cipher.encryptToken(PLAINTEXT, CONTEXT);

    expect(first).not.toBe(second);
    expect(cipher.decryptToken(first, CONTEXT)).toBe(PLAINTEXT);
    expect(cipher.decryptToken(second, CONTEXT)).toBe(PLAINTEXT);
  });

  it("does not contain the plaintext and uses a versioned format with the key id", () => {
    const encrypted = cipher.encryptToken(PLAINTEXT, CONTEXT);

    expect(encrypted).not.toContain(PLAINTEXT);
    expect(encrypted.startsWith("v1.k1.")).toBe(true);
    expect(encrypted.split(".")).toHaveLength(5);
  });

  it.each([
    ["nonce", 2],
    ["ciphertext", 3],
    ["authentication tag", 4],
  ])("rejects a modified %s", (_name, index) => {
    const encrypted = cipher.encryptToken(PLAINTEXT, CONTEXT);

    expect(() => cipher.decryptToken(tamperPart(encrypted, index), CONTEXT)).toThrow(
      TokenCryptoError,
    );
  });

  it("rejects a modified key id and version", () => {
    const encrypted = cipher.encryptToken(PLAINTEXT, CONTEXT);

    expect(() => cipher.decryptToken(encrypted.replace("v1.k1.", "v1.k2."), CONTEXT)).toThrow(
      TokenCryptoError,
    );
    expect(() => cipher.decryptToken(encrypted.replace("v1.", "v2."), CONTEXT)).toThrow(
      TokenCryptoError,
    );
  });

  it("rejects a different context (another item or environment)", () => {
    const encrypted = cipher.encryptToken(PLAINTEXT, CONTEXT);

    expect(() =>
      cipher.decryptToken(encrypted, plaidItemTokenContext("sandbox", "item_other")),
    ).toThrow(TokenCryptoError);
    expect(() =>
      cipher.decryptToken(encrypted, plaidItemTokenContext("production", "item_abc123")),
    ).toThrow(TokenCryptoError);
  });

  it("rejects the wrong key even with the same key id", () => {
    const encrypted = cipher.encryptToken(PLAINTEXT, CONTEXT);
    const other = createTokenCipher({ current: keyB });

    expect(() => other.decryptToken(encrypted, CONTEXT)).toThrow(TokenCryptoError);
  });

  it.each([
    "",
    "garbage",
    "v1.k1.a.b",
    "v1.k1.a.b.c.d",
    "v1.k1.!!!.!!!.!!!",
    "v1.k1..." + ".",
  ])("rejects malformed input %j", (input) => {
    expect(() => cipher.decryptToken(input, CONTEXT)).toThrow(TokenCryptoError);
  });

  it("rejects non-canonical base64url that decodes to the same bytes", () => {
    const encrypted = cipher.encryptToken(PLAINTEXT, CONTEXT);
    const parts = encrypted.split(".");
    // Padding is never emitted, so adding it must not be tolerated.
    parts[4] = parts[4] + "=";

    expect(() => cipher.decryptToken(parts.join("."), CONTEXT)).toThrow(TokenCryptoError);
  });

  it("never puts the token or ciphertext into error messages", () => {
    const encrypted = cipher.encryptToken(PLAINTEXT, CONTEXT);
    const tampered = tamperPart(encrypted, 3);

    let message = "";
    try {
      cipher.decryptToken(tampered, CONTEXT);
    } catch (error) {
      message = String(error instanceof Error ? error.message : error);
    }

    expect(message).not.toBe("");
    expect(message).not.toContain(PLAINTEXT);
    expect(message).not.toContain(tampered);
  });

  it("rejects an empty token or empty context", () => {
    expect(() => cipher.encryptToken("", CONTEXT)).toThrow(TokenCryptoError);
    expect(() => cipher.encryptToken(PLAINTEXT, "")).toThrow(TokenCryptoError);
    expect(() => cipher.decryptToken("v1.k1.a.b.c", "")).toThrow(TokenCryptoError);
  });

  it("rejects keys of the wrong size and unsafe key ids", () => {
    expect(() => createTokenCipher({ current: { keyId: "k1", key: Buffer.alloc(16) } })).toThrow(
      TokenCryptoError,
    );
    expect(() => createTokenCipher({ current: { keyId: "k.1", key: Buffer.alloc(32) } })).toThrow(
      TokenCryptoError,
    );
  });

  it("supports rotation: new key encrypts, retired key still decrypts old data", () => {
    const old = createTokenCipher({ current: { keyId: "k1", key: Buffer.alloc(32, 1) } });
    const stored = old.encryptToken(PLAINTEXT, CONTEXT);

    const rotated = createTokenCipher({
      current: { keyId: "k2", key: Buffer.alloc(32, 9) },
      retired: [{ keyId: "k1", key: Buffer.alloc(32, 1) }],
    });

    expect(rotated.decryptToken(stored, CONTEXT)).toBe(PLAINTEXT);
    expect(rotated.encryptToken(PLAINTEXT, CONTEXT).startsWith("v1.k2.")).toBe(true);
  });

  it("fails clearly when the key for a stored token is no longer configured", () => {
    const old = createTokenCipher({ current: { keyId: "k1", key: Buffer.alloc(32, 1) } });
    const stored = old.encryptToken(PLAINTEXT, CONTEXT);
    const rotatedWithoutRetired = createTokenCipher({
      current: { keyId: "k2", key: Buffer.alloc(32, 9) },
    });

    expect(() => rotatedWithoutRetired.decryptToken(stored, CONTEXT)).toThrow(TokenCryptoError);
  });
});

describe("plaidItemTokenContext", () => {
  it("is unambiguous across environment and item id", () => {
    expect(plaidItemTokenContext("sandbox", "item_1")).not.toBe(
      plaidItemTokenContext("production", "item_1"),
    );
    // A crafted item id must not be able to impersonate another environment.
    expect(plaidItemTokenContext("sandbox", "production:item_1")).not.toBe(
      plaidItemTokenContext("production", "item_1"),
    );
  });

  it("rejects an empty item id", () => {
    expect(() => plaidItemTokenContext("sandbox", "")).toThrow(TokenCryptoError);
  });
});

describe("encryptToken / decryptToken bound to server configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubValidEnv(key: Buffer) {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db:5432/x");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", key.toString("base64"));
    vi.stubEnv("TOKEN_ENCRYPTION_KEY_ID", "k1");
    vi.stubEnv("AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("APP_URL", "http://localhost:3000");
  }

  it("round-trips using the configured key", () => {
    stubValidEnv(Buffer.alloc(32, 5));

    const encrypted = encryptToken(PLAINTEXT, CONTEXT);

    expect(decryptToken(encrypted, CONTEXT)).toBe(PLAINTEXT);
  });

  it("cannot decrypt after the configured key changes", () => {
    stubValidEnv(Buffer.alloc(32, 5));
    const encrypted = encryptToken(PLAINTEXT, CONTEXT);

    stubValidEnv(Buffer.alloc(32, 6));

    expect(() => decryptToken(encrypted, CONTEXT)).toThrow(TokenCryptoError);
  });

  describe("after a rotation (configured retired keys)", () => {
    const oldKey = Buffer.alloc(32, 5);
    const newKey = Buffer.alloc(32, 6);

    function stubRotatedEnv(retired: string) {
      stubValidEnv(newKey);
      vi.stubEnv("TOKEN_ENCRYPTION_KEY_ID", "v2");
      vi.stubEnv("TOKEN_ENCRYPTION_RETIRED_KEYS", retired);
    }

    it("still reads data written under the retired key, and writes under the new one", () => {
      const stored = createTokenCipher({ current: { keyId: "v1", key: oldKey } }).encryptToken(PLAINTEXT, CONTEXT);
      stubRotatedEnv("v1:" + oldKey.toString("base64"));

      expect(decryptToken(stored, CONTEXT)).toBe(PLAINTEXT);
      expect(tokenKeyId(encryptToken(PLAINTEXT, CONTEXT))).toBe("v2");
    });

    it("cannot read the old data once the retired key is removed", () => {
      const stored = createTokenCipher({ current: { keyId: "v1", key: oldKey } }).encryptToken(PLAINTEXT, CONTEXT);
      stubRotatedEnv("");

      expect(() => decryptToken(stored, CONTEXT)).toThrow(TokenCryptoError);
    });
  });
});
