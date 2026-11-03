import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getServerConfig } from "@/lib/config";

// Household-scale traffic; keep the pool small so PostgreSQL (which shares a
// small machine with the app) is never flooded with connections.
const MAX_CONNECTIONS = 5;

export function createDbClient(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: MAX_CONNECTIONS }),
  });
}

// One client per server process. Caching on globalThis (rather than a module
// variable) keeps a single pool across Next.js dev hot reloads, which re-evaluate
// modules and would otherwise leak a new pool on every edit.
const globalForDb = globalThis as unknown as { homeFinancesDb?: PrismaClient };

/** The app's database client. Connects as the restricted application role. */
export function getDb(): PrismaClient {
  globalForDb.homeFinancesDb ??= createDbClient(getServerConfig().databaseUrl);
  return globalForDb.homeFinancesDb;
}
