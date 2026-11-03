import { describe, expect, it } from "vitest";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PasswordPolicyError,
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
} from "@/lib/auth/password";

// Synthetic passwords only.
const PASSWORD = "correct horse battery staple";

describe("password hashing", () => {
  it("produces an Argon2id hash that does not contain the password", async () => {
    const hash = await hashPassword(PASSWORD);

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain(PASSWORD);
  });

  it("uses a fresh salt each time", async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    expect(first).not.toBe(second);
  });

  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword(PASSWORD);

    expect(await verifyPassword({ password: PASSWORD, hash })).toBe(true);
    expect(await verifyPassword({ password: PASSWORD + "x", hash })).toBe(false);
    expect(await verifyPassword({ password: "", hash })).toBe(false);
  });

  it.each(["", "not-a-hash", "$argon2id$garbage", "$2b$10$abcdefghijklmnopqrstuv"])(
    "treats a malformed stored hash %j as a failed verification, not a crash",
    async (hash) => {
      expect(await verifyPassword({ password: PASSWORD, hash })).toBe(false);
    },
  );

  it("still verifies a hash made with different Argon2id parameters", async () => {
    // Parameters are read from the stored hash, so existing hashes keep working
    // after a future cost increase.
    const { hash } = await import("@node-rs/argon2");
    const weak = await hash(PASSWORD, { algorithm: 2, memoryCost: 8, timeCost: 1, parallelism: 1 });

    expect(await verifyPassword({ password: PASSWORD, hash: weak })).toBe(true);
  });
});

describe("password policy", () => {
  it("accepts a password at the minimum and maximum lengths", () => {
    expect(() => assertPasswordPolicy("a".repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
    expect(() => assertPasswordPolicy("a".repeat(MAX_PASSWORD_LENGTH))).not.toThrow();
  });

  it("rejects short and overlong passwords without echoing them", () => {
    const short = "short-pw";
    const long = "x".repeat(MAX_PASSWORD_LENGTH + 1);

    expect(() => assertPasswordPolicy(short)).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy(long)).toThrow(PasswordPolicyError);
    try {
      assertPasswordPolicy(short);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(short);
    }
  });

  it("is at least 12 characters", () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
  });
});
