import { createPlaidApi } from "@/features/plaid/client";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import { getServerConfig } from "@/lib/config";
import { decryptToken, plaidItemTokenContext } from "@/lib/crypto/tokens";
import { getDb } from "@/lib/db";
import { UserSetupError, findSoleHousehold } from "./lib/users.mjs";

/**
 * Sandbox-only helper for trying the reconnect flow by hand.
 *
 *   docker compose exec app npm run plaid:sandbox                    -> list connections
 *   docker compose exec app npm run plaid:sandbox -- reset-login <id> -> make the bank demand a fresh sign-in
 *
 * `reset-login` calls Plaid's Sandbox-only /sandbox/item/reset_login for one of
 * your connections. Afterwards, press "Refresh accounts" on that connection:
 * Plaid answers ITEM_LOGIN_REQUIRED, the card changes to "Sign-in needed", and
 * "Reconnect" repairs it. Refuses to run outside Sandbox. Uses an explicit
 * household lookup (it works only when there is exactly one household), not any
 * web session.
 */

async function main() {
  const [command = "list", connectionId] = process.argv.slice(2);
  const config = getServerConfig();
  if (config.plaidEnv !== "sandbox" || getPlaidEnvironment() !== "SANDBOX") {
    throw new UserSetupError("This command only works with PLAID_ENV=sandbox");
  }

  const db = getDb();
  try {
    const household = await findSoleHousehold(db);
    const connections = await db.plaidItem.findMany({
      where: { householdId: household.id, environment: "SANDBOX", status: { not: "DISCONNECTED" } },
      orderBy: { createdAt: "asc" },
    });

    if (command === "list") {
      if (connections.length === 0) console.log("No connected Sandbox banks.");
      for (const c of connections) console.log(`${c.id}  ${c.status.padEnd(14)} ${c.institutionName ?? "(unnamed)"}`);
      return;
    }

    if (command === "reset-login") {
      const connection = connections.find((c) => c.id === connectionId);
      if (!connection?.accessTokenCiphertext) {
        throw new UserSetupError("Give the id of one of the connections listed by this command");
      }
      if (!config.plaid) throw new UserSetupError("Plaid credentials are not configured");
      const accessToken = decryptToken(
        connection.accessTokenCiphertext,
        plaidItemTokenContext(connection.environment, connection.plaidItemId),
      );
      const api = createPlaidApi({ ...config.plaid, environment: "sandbox" });
      await api.sandboxItemResetLogin({ access_token: accessToken });
      console.log(`Reset. Press "Refresh accounts" on "${connection.institutionName ?? "that connection"}", then "Reconnect".`);
      return;
    }

    throw new UserSetupError("Usage: plaid:sandbox [list | reset-login <connection id>]");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Deliberately terse: SDK errors embed the request, including credentials.
  if (error instanceof UserSetupError) console.error(`Error: ${error.message}`);
  else console.error("Error: the request failed. Check the Plaid credentials and that the database is running.");
  process.exitCode = 1;
});
