import "server-only";
import { z } from "zod";

/**
 * Validated, typed server configuration.
 *
 * Error messages deliberately name only the variable, never its value, so a
 * misconfigured secret cannot leak into logs or an error page.
 */

const HINTS = {
  DATABASE_URL: "must be a postgresql:// connection URL",
  PLAID_ENV: 'must be "sandbox" or "production"',
  PLAID_CLIENT_ID: "is required when PLAID_SECRET is set",
  PLAID_SECRET: "is required when PLAID_CLIENT_ID is set",
  PLAID_REDIRECT_URI: "must be an https:// URL",
  TOKEN_ENCRYPTION_KEY: "must be 32 random bytes encoded as base64",
  TOKEN_ENCRYPTION_KEY_ID: "must be 1-32 letters, digits, '-' or '_'",
  AUTH_SECRET: "must be at least 32 characters",
  APP_URL: "must be an http(s) URL",
} as const;

// Padded standard base64 of exactly 32 bytes is 44 chars ending in a single "=".
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

const envSchema = z
  .object({
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/\S+$/),
    PLAID_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
    PLAID_CLIENT_ID: z.string().min(1).optional(),
    PLAID_SECRET: z.string().min(1).optional(),
    PLAID_REDIRECT_URI: z.string().regex(/^https:\/\/\S+$/).optional(),
    TOKEN_ENCRYPTION_KEY: z.string().regex(BASE64_32_BYTES),
    TOKEN_ENCRYPTION_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    AUTH_SECRET: z.string().min(32),
    APP_URL: z.string().regex(/^https?:\/\/\S+$/),
  })
  .superRefine((env, ctx) => {
    // Plaid credentials are optional until the Plaid client is wired up
    // (Task 4), but a half-configured pair is always a mistake.
    if (env.PLAID_CLIENT_ID && !env.PLAID_SECRET) {
      ctx.addIssue({ code: "custom", path: ["PLAID_SECRET"] });
    }
    if (env.PLAID_SECRET && !env.PLAID_CLIENT_ID) {
      ctx.addIssue({ code: "custom", path: ["PLAID_CLIENT_ID"] });
    }
  });

export type ServerConfig = {
  databaseUrl: string;
  appUrl: string;
  authSecret: string;
  plaidEnv: "sandbox" | "production";
  plaid: { clientId: string; secret: string } | null;
  plaidRedirectUri: string | null;
  tokenEncryption: { key: Buffer; keyId: string };
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function getServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  // Blank values (e.g. `PLAID_SECRET=` copied from .env.example) mean "unset".
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );

  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const name = String(issue.path[0]) as keyof typeof HINTS;
          return `${name} ${HINTS[name] ?? "is invalid"}`;
        }),
      ),
    ];
    throw new ConfigError(`Invalid server configuration: ${problems.join("; ")}`);
  }

  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    appUrl: e.APP_URL,
    authSecret: e.AUTH_SECRET,
    plaidEnv: e.PLAID_ENV,
    plaid:
      e.PLAID_CLIENT_ID && e.PLAID_SECRET
        ? { clientId: e.PLAID_CLIENT_ID, secret: e.PLAID_SECRET }
        : null,
    plaidRedirectUri: e.PLAID_REDIRECT_URI ?? null,
    tokenEncryption: {
      key: Buffer.from(e.TOKEN_ENCRYPTION_KEY, "base64"),
      keyId: e.TOKEN_ENCRYPTION_KEY_ID,
    },
  };
}
