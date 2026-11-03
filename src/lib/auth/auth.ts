import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import type { PrismaClient } from "@/generated/prisma/client";
import { getServerConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from "./password";
import { shouldUseSecureCookies } from "./origin";

const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7; // 7 days
const SESSION_REFRESH_SECONDS = 60 * 60 * 24; // extend at most once a day

// Sign-in attempts allowed per window. Together with the shared bucket below
// this caps password guessing at a handful of tries a minute.
const SIGN_IN_WINDOW_SECONDS = 60;
const SIGN_IN_MAX_ATTEMPTS = 5;

type AuthDeps = { db: PrismaClient; secret: string; baseURL: string };

/**
 * The one place authentication is configured. See docs/auth.md for why Better
 * Auth was chosen and what each setting is for.
 */
export function createAuth({ db, secret, baseURL }: AuthDeps) {
  const secure = shouldUseSecureCookies(baseURL);

  return betterAuth({
    appName: "Home Finances",
    baseURL,
    secret,
    database: prismaAdapter(db, { provider: "postgresql" }),

    // Cross-origin requests to /api/auth/* are rejected unless they come from
    // the app's own origin (this is the CSRF defence for the auth routes).
    trustedOrigins: [new URL(baseURL).origin],

    emailAndPassword: {
      enabled: true,
      // Closed registration: nobody can create an account over HTTP. Users are
      // created only by the bootstrap CLI (scripts/bootstrap-user.mts).
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      password: { hash: hashPassword, verify: verifyPassword },
    },

    // Our bank "Account" model owns that name; the credential table is
    // AuthAccount.
    account: { modelName: "authAccount" },

    session: {
      expiresIn: SESSION_LIFETIME_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
    },

    advanced: {
      // Spelled out on purpose: Better Auth skips its origin check by default
      // when NODE_ENV is "test", so relying on the default would let a
      // misconfigured environment silently turn CSRF protection off.
      disableCSRFCheck: false,
      disableOriginCheck: false,
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure },
      // Primary keys in our schema are UUID columns.
      database: { generateId: "uuid" },
      // Do not trust X-Forwarded-For: anyone who can reach the app directly
      // could rotate it to dodge throttling. With no trusted client address all
      // sign-in attempts share one counter, which is the right model for a
      // single-household app. Revisit when a trusted reverse proxy is added.
      ipAddress: { ipAddressHeaders: [] },
    },

    rateLimit: {
      enabled: true,
      // In the database so counters survive restarts and are shared by
      // instances; see the RateLimit model.
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: SIGN_IN_WINDOW_SECONDS, max: SIGN_IN_MAX_ATTEMPTS },
      },
    },

    // Must be last: lets sign-in/out set cookies when called from Server Actions.
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

// Kept on globalThis for the same reason as the Prisma client (see db.ts):
// dev-mode hot reloads re-evaluate modules but must not rebuild the instance.
const globalForAuth = globalThis as unknown as { homeFinancesAuth?: Auth };

/** The process-wide auth instance, built lazily from validated config. */
export function getAuth(): Auth {
  if (!globalForAuth.homeFinancesAuth) {
    const config = getServerConfig();
    globalForAuth.homeFinancesAuth = createAuth({
      db: getDb(),
      secret: config.authSecret,
      baseURL: config.appUrl,
    });
  }
  return globalForAuth.homeFinancesAuth;
}
