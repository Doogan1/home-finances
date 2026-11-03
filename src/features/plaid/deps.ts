import "server-only";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";
import { getDb } from "@/lib/db";
import { getPlaidGateway } from "./client";
import { getPlaidEnvironment } from "./environment";
import type { LinkDeps } from "./types";

/**
 * Production wiring for the link and account services: the real database,
 * the real Plaid gateway and the configured token key. Routes call this at
 * request time; tests build their own LinkDeps instead.
 *
 * Throws PlaidNotConfiguredError when Plaid credentials are not set.
 */
export function getLinkDeps(): LinkDeps {
  return {
    db: getDb(),
    plaid: getPlaidGateway(),
    environment: getPlaidEnvironment(),
    tokens: { encrypt: encryptToken, decrypt: decryptToken },
  };
}
