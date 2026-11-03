import { hash, verify, type Options } from "@node-rs/argon2";

/**
 * Argon2id password hashing, plugged into Better Auth as its `password.hash` /
 * `password.verify`. This module is deliberately free of `server-only` so the
 * bootstrap CLI can use exactly the same hashing as the web app.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

// 64 MiB, 3 passes: above OWASP's Argon2id minimums. Parallelism 1 keeps a
// single sign-in from monopolising CPU cores in a small container. The
// parameters are stored inside every hash, so raising them later does not
// invalidate existing passwords.
const OPTIONS: Options = {
  algorithm: 2, // Algorithm.Argon2id (const enum, so spelled as its value)
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
};

export class PasswordPolicyError extends Error {
  constructor() {
    super(`Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`);
    this.name = "PasswordPolicyError";
  }
}

/** Throws without echoing the password. */
export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError();
  }
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** A malformed or foreign stored hash is a failed login, never an exception. */
export async function verifyPassword(data: { password: string; hash: string }): Promise<boolean> {
  try {
    return await verify(data.hash, data.password);
  } catch {
    return false;
  }
}
