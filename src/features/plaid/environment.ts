import "server-only";
import type { PlaidEnvironment } from "@/generated/prisma/client";
import { getServerConfig } from "@/lib/config";

/** The Plaid environment this server is configured for (Sandbox unless explicitly changed). */
export function getPlaidEnvironment(): PlaidEnvironment {
  return getServerConfig().plaidEnv === "production" ? "PRODUCTION" : "SANDBOX";
}

export function isPlaidConfigured(): boolean {
  return getServerConfig().plaid !== null;
}
