import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createHouseholdWithOwner } from "./lib/users.mjs";

/**
 * Creates and removes a throwaway household + user for the browser (Playwright)
 * tests, which run against the live development app. Everything it makes is
 * labelled so it can be told apart from real data, and `delete` refuses to
 * touch anything without that label.
 *
 *   tsx scripts/e2e-user.mts create   -> prints {"email","password","householdId"} as JSON
 *   tsx scripts/e2e-user.mts delete <email>
 *   tsx scripts/e2e-user.mts reset-throttle
 *
 * The password is random per run and exists only in the test process.
 */

const EMAIL_PATTERN = /^e2e\.[a-f0-9]{12}@example\.test$/;
const HOUSEHOLD_PREFIX = "E2E test household ";

async function main() {
  const [command, argument] = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 1 }) });

  try {
    if (command === "create") {
      const id = randomBytes(6).toString("hex");
      const email = `e2e.${id}@example.test`;
      const password = randomBytes(18).toString("base64url");
      const { householdId } = await createHouseholdWithOwner(db, {
        householdName: `${HOUSEHOLD_PREFIX}${id}`,
        name: "E2E Tester",
        email,
        password,
      });
      console.log(JSON.stringify({ email, password, householdId }));
    } else if (command === "reset-throttle") {
      // Sign-in attempts share one counter, so a test run that exercises the
      // limit would otherwise leave the real user locked out for a minute.
      await db.rateLimit.deleteMany();
    } else if (command === "delete" && argument && EMAIL_PATTERN.test(argument)) {
      const user = await db.user.findUnique({
        where: { email: argument },
        include: { memberships: { include: { household: true } } },
      });
      if (!user) return;
      const households = user.memberships
        .map((m) => m.household)
        .filter((h) => h.name.startsWith(HOUSEHOLD_PREFIX));
      // Deleting the user cascades to sessions, credentials and memberships.
      await db.user.delete({ where: { id: user.id } });
      await db.household.deleteMany({ where: { id: { in: households.map((h) => h.id) } } });
    } else {
      throw new Error("Usage: e2e-user.mts create | reset-throttle | delete <e2e.xxxxxxxxxxxx@example.test>");
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "e2e-user failed");
  process.exitCode = 1;
});
