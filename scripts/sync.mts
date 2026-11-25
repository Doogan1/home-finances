import { runMatchingQuietly } from "@/features/payments/service";
import { getLinkDeps } from "@/features/plaid/deps";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import { syncItem } from "@/features/plaid/sync";
import { PlaidFlowError, PlaidNotConfiguredError, type SyncSummary } from "@/features/plaid/types";
import { getDb } from "@/lib/db";
import { UserSetupError, findSoleHousehold } from "./lib/users.mjs";

/**
 * Syncs transactions from the command line, using exactly the same service as
 * the "Sync now" button (leasing, retries, all-or-nothing commit). It is an
 * explicit action and is not rate limited the way the button is.
 *
 *   docker compose exec app npm run sync                 -> list connections
 *   docker compose exec app npm run sync -- <id>         -> sync one connection
 *   docker compose exec app npm run sync -- --all        -> sync every connected bank
 *
 * This is an operator tool, not a web path: it resolves the household with an
 * explicit lookup (it works only when there is exactly one) and never goes
 * through a web session.
 */

const MESSAGES: Record<string, string> = {
  connection_not_found: "That connection was not found (or is disconnected).",
  reconnect_required: "The bank needs you to sign in again. Reconnect it in the app first.",
  sync_in_progress: "A sync is already running for that connection.",
  token_unreadable: "The stored connection key can no longer be read. Reconnect the bank in the app.",
};

function describe(summary: SyncSummary): string {
  const counts = `${summary.added} added, ${summary.modified} modified, ${summary.removed} removed`;
  if (summary.status === "FAILED") return `FAILED (${summary.errorCode}); nothing was changed`;
  if (summary.providerStatus === "NOT_READY") return `OK, but Plaid has no transactions for this bank yet (${counts})`;
  return `OK: ${counts}`;
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const ids = args.filter((a) => !a.startsWith("--"));
  if (args.some((a) => a.startsWith("--") && a !== "--all") || ids.length > 1) {
    throw new UserSetupError("Usage: sync [<connection id> | --all]");
  }

  const db = getDb();
  try {
    const household = await findSoleHousehold(db);
    const connections = await db.plaidItem.findMany({
      where: { householdId: household.id, environment: getPlaidEnvironment(), status: { not: "DISCONNECTED" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, institutionName: true, status: true, lastSuccessfulSyncAt: true },
    });

    if (!all && ids.length === 0) {
      if (connections.length === 0) console.log("No connected banks.");
      for (const c of connections) {
        const last = c.lastSuccessfulSyncAt ? c.lastSuccessfulSyncAt.toISOString() : "never";
        console.log(`${c.id}  ${c.status.padEnd(14)} last synced: ${last.padEnd(24)} ${c.institutionName ?? "(unnamed)"}`);
      }
      return;
    }

    const targets = all ? connections : connections.filter((c) => c.id === ids[0]);
    if (targets.length === 0) throw new UserSetupError("No such connection. Run without arguments to list them.");

    const deps = getLinkDeps();
    let anyFailed = false;
    for (const target of targets) {
      const label = target.institutionName ?? target.id;
      try {
        const summary = await syncItem(deps, household.id, target.id);
        console.log(`${label}: ${describe(summary)}`);
        if (summary.status === "FAILED") anyFailed = true;
      } catch (error) {
        anyFailed = true;
        const known = error instanceof PlaidFlowError ? MESSAGES[error.code] : undefined;
        console.log(`${label}: ${known ?? "could not start the sync"}`);
      }
    }
    const { linked } = await runMatchingQuietly(db, household.id, { environment: getPlaidEnvironment() });
    if (linked > 0) console.log(`Matched ${linked} ${linked === 1 ? "payment" : "payments"} to bills and income.`);
    if (anyFailed) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Deliberately terse: SDK errors embed the request, including credentials.
  if (error instanceof UserSetupError) console.error(`Error: ${error.message}`);
  else if (error instanceof PlaidNotConfiguredError) console.error("Error: Plaid credentials are not configured.");
  else console.error("Error: the request failed. Check the Plaid credentials and that the database is running.");
  process.exitCode = 1;
});
