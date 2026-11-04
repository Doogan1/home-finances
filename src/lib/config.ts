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
  PLAID_LIVE_OPT_IN: 'must be "yes" before PLAID_ENV=production is allowed (it links real banks)',
  PLAID_CLIENT_ID: "is required when PLAID_SECRET is set",
  PLAID_SECRET: "is required when PLAID_CLIENT_ID is set",
  PLAID_REDIRECT_URI:
    "must be an https:// URL without a query or fragment (http://localhost is allowed only in sandbox)",
  TOKEN_ENCRYPTION_KEY: "must be 32 random bytes encoded as base64",
  TOKEN_ENCRYPTION_KEY_ID: "must be 1-32 letters, digits, '-' or '_'",
  TOKEN_ENCRYPTION_RETIRED_KEYS:
    "must be comma-separated id:key pairs (32 random bytes as base64), with ids different from each other and from the current key",
  AUTH_SECRET: "must be at least 32 characters",
  APP_URL: "must be an http(s) URL",
} as const;

// Padded standard base64 of exactly 32 bytes is 44 chars ending in a single "=".
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

const RETIRED_KEY_ENTRY = /^([A-Za-z0-9_-]{1,32}):([A-Za-z0-9+/]{43}=)$/;

/**
 * Old encryption keys that may still decrypt existing data while it is being
 * re-encrypted under the current key ("id:base64,id2:base64"). Returns null when
 * any entry is malformed or an id repeats (including the current key's id).
 */
function parseRetiredKeys(value: string | undefined, currentKeyId: string): { keyId: string; key: Buffer }[] | null {
  if (value === undefined || value.trim() === "") return [];
  const seen = new Set([currentKeyId]);
  const keys: { keyId: string; key: Buffer }[] = [];
  for (const entry of value.split(",")) {
    const match = RETIRED_KEY_ENTRY.exec(entry.trim());
    if (!match || seen.has(match[1])) return null;
    seen.add(match[1]);
    keys.push({ keyId: match[1], key: Buffer.from(match[2], "base64") });
  }
  return keys;
}

/**
 * Plaid requires https redirect URIs, with no query string or fragment. Its
 * Sandbox alone also accepts plain http on localhost, so OAuth can be tried
 * without a certificate. Anything else would fail at Plaid, so it is refused
 * here with a clearer message.
 */
function isAcceptableRedirectUri(value: string, plaidEnv: "sandbox" | "production"): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.search || url.hash || url.username || url.password || /\s/.test(value)) return false;
  if (url.protocol === "https:") return true;
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return url.protocol === "http:" && localhost && plaidEnv === "sandbox";
}

const envSchema = z
  .object({
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/\S+$/),
    PLAID_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
    PLAID_LIVE_OPT_IN: z.string().optional(),
    PLAID_CLIENT_ID: z.string().min(1).optional(),
    PLAID_SECRET: z.string().min(1).optional(),
    PLAID_REDIRECT_URI: z.string().optional(),
    TOKEN_ENCRYPTION_KEY: z.string().regex(BASE64_32_BYTES),
    TOKEN_ENCRYPTION_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    TOKEN_ENCRYPTION_RETIRED_KEYS: z.string().optional(),
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
    if (parseRetiredKeys(env.TOKEN_ENCRYPTION_RETIRED_KEYS, env.TOKEN_ENCRYPTION_KEY_ID) === null) {
      ctx.addIssue({ code: "custom", path: ["TOKEN_ENCRYPTION_RETIRED_KEYS"] });
    }
    // Real banks are an explicit, separate decision: changing PLAID_ENV alone
    // (or copying a production .env by accident) must not start linking them.
    if (env.PLAID_ENV === "production" && env.PLAID_LIVE_OPT_IN !== "yes") {
      ctx.addIssue({ code: "custom", path: ["PLAID_LIVE_OPT_IN"] });
    }
    if (env.PLAID_REDIRECT_URI && !isAcceptableRedirectUri(env.PLAID_REDIRECT_URI, env.PLAID_ENV)) {
      ctx.addIssue({ code: "custom", path: ["PLAID_REDIRECT_URI"] });
    }
  });

export type ServerConfig = {
  databaseUrl: string;
  appUrl: string;
  authSecret: string;
  plaidEnv: "sandbox" | "production";
  plaid: { clientId: string; secret: string } | null;
  plaidRedirectUri: string | null;
  tokenEncryption: {
    key: Buffer;
    keyId: string;
    /** Old keys that may still decrypt existing data; never used to encrypt. */
    retired: { keyId: string; key: Buffer }[];
  };
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
      retired: parseRetiredKeys(e.TOKEN_ENCRYPTION_RETIRED_KEYS, e.TOKEN_ENCRYPTION_KEY_ID) ?? [],
    },
  };
}
