import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type ItemStatus } from "@/generated/prisma/client";
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
 *   tsx scripts/e2e-user.mts seed-bank <email>   -> synthetic connections with fake accounts
 *
 * The password is random per run and exists only in the test process.
 */

const EMAIL_PATTERN = /^e2e\.[a-f0-9]{12}@example\.test$/;
const HOUSEHOLD_PREFIX = "E2E test household ";
// Planted in the fake stored token so tests can prove it never reaches a browser.
const SENTINEL_CIPHERTEXT = "v1.e2e.E2E-SENTINEL-CIPHERTEXT.not-a-real-token.x";

type SeedAccount = {
  id: string;
  name: string;
  mask: string;
  type: string;
  subtype: string;
  current: string;
  available: string | null;
  limit: string | null;
  ageHours: number;
};

// Three states a connection can be in. None of them can reach Plaid: the fake
// token is not decryptable, and tests never click anything that would call out.
const SEEDED_CONNECTIONS: {
  key: string;
  institutionName: string;
  status: ItemStatus;
  hasToken: boolean;
  accounts: SeedAccount[];
}[] = [
  {
    key: "main",
    institutionName: "First Platypus Bank (E2E)",
    status: "ACTIVE",
    hasToken: true,
    accounts: [
      { id: "checking", name: "E2E Checking", mask: "0000", type: "depository", subtype: "checking", current: "110", available: "100", limit: null, ageHours: 0 },
      { id: "card", name: "E2E Credit Card", mask: "3333", type: "credit", subtype: "credit card", current: "410", available: null, limit: "2000", ageHours: 72 },
      { id: "savings", name: "E2E Savings", mask: "1111", type: "depository", subtype: "savings", current: "1234.5", available: null, limit: null, ageHours: 0 },
    ],
  },
  {
    key: "reauth",
    institutionName: "E2E Needs Sign-in Bank",
    status: "LOGIN_REQUIRED",
    hasToken: true,
    accounts: [
      { id: "reauth", name: "E2E Reauth Account", mask: "4444", type: "depository", subtype: "checking", current: "50", available: "50", limit: null, ageHours: 5 },
    ],
  },
  {
    key: "closed",
    institutionName: "E2E Closed Bank",
    status: "DISCONNECTED",
    hasToken: false,
    accounts: [
      { id: "closed", name: "E2E Closed Account", mask: "5555", type: "depository", subtype: "checking", current: "75.25", available: "75.25", limit: null, ageHours: 48 },
    ],
  },
];

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
    } else if (command === "seed-bank" && argument && EMAIL_PATTERN.test(argument)) {
      const user = await db.user.findUniqueOrThrow({
        where: { email: argument },
        include: { memberships: { include: { household: true } } },
      });
      const household = user.memberships.map((m) => m.household).find((h) => h.name.startsWith(HOUSEHOLD_PREFIX));
      if (!household) throw new Error("Refusing to seed a household that is not an E2E household");

      const now = Date.now();
      for (const connection of SEEDED_CONNECTIONS) {
        const item = await db.plaidItem.create({
          data: {
            householdId: household.id,
            environment: "SANDBOX",
            plaidItemId: `item_e2e_${connection.key}_${randomBytes(4).toString("hex")}`,
            accessTokenCiphertext: connection.hasToken ? SENTINEL_CIPHERTEXT : null,
            institutionName: connection.institutionName,
            status: connection.status,
            lastErrorCode: connection.status === "LOGIN_REQUIRED" ? "ITEM_LOGIN_REQUIRED" : null,
          },
        });
        for (const a of connection.accounts) {
          const account = await db.account.create({
            data: {
              householdId: household.id,
              plaidItemId: item.id,
              externalAccountId: `acct_e2e_${a.id}`,
              name: a.name,
              mask: a.mask,
              type: a.type,
              subtype: a.subtype,
              currency: "USD",
              active: connection.status !== "DISCONNECTED",
              unavailableSince: connection.status === "DISCONNECTED" ? new Date(now - 24 * 3_600_000) : null,
            },
          });
          await db.balanceSnapshot.create({
            data: {
              accountId: account.id,
              observedAt: new Date(now - a.ageHours * 3_600_000),
              current: a.current,
              available: a.available,
              limit: a.limit,
              currency: "USD",
              source: "ACCOUNTS_GET",
            },
          });
        }
      }
    } else if (command === "delete" && argument && EMAIL_PATTERN.test(argument)) {
      const user = await db.user.findUnique({
        where: { email: argument },
        include: { memberships: { include: { household: true } } },
      });
      if (!user) return;
      const households = user.memberships
        .map((m) => m.household)
        .filter((h) => h.name.startsWith(HOUSEHOLD_PREFIX));
      const householdIds = households.map((h) => h.id);
      // Deleting the user cascades to sessions, credentials and memberships.
      await db.user.delete({ where: { id: user.id } });
      // A household cannot be deleted while it still has connections or link
      // attempts (by design), so remove those first; accounts, balances and
      // transactions go with their connection.
      await db.linkAttempt.deleteMany({ where: { householdId: { in: householdIds } } });
      await db.plaidItem.deleteMany({ where: { householdId: { in: householdIds } } });
      await db.household.deleteMany({ where: { id: { in: householdIds } } });
    } else {
      throw new Error("Usage: e2e-user.mts create | reset-throttle | seed-bank | delete <e2e.xxxxxxxxxxxx@example.test>");
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "e2e-user failed");
  process.exitCode = 1;
});
