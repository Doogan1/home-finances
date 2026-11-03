import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { promptHidden, promptLine } from "./lib/prompt.mjs";
import {
  UserSetupError,
  addMember,
  createHouseholdWithOwner,
  findSoleHousehold,
  householdCount,
} from "./lib/users.mjs";

/**
 * Creates the first household member, or adds another member to the household.
 *
 *   docker compose exec app npm run auth:bootstrap
 *   docker compose exec app npm run auth:bootstrap -- --add-member
 *
 * Registration through the web app is closed; this is the only way accounts are
 * created. The password is typed at a hidden prompt and never accepted as an
 * argument or environment variable. There is no default password.
 */

const addingMember = process.argv.includes("--add-member");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--add-member");

async function main() {
  if (unknownArgs.length > 0) {
    throw new UserSetupError("Usage: auth:bootstrap [--add-member]. Passwords are never accepted as arguments");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new UserSetupError("DATABASE_URL is not set");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 1 }) });
  try {
    if (addingMember) {
      const household = await findSoleHousehold(db);
      console.log(`Adding a member to household "${household.name}".`);
      const person = await promptPerson();
      await addMember(db, { householdId: household.id, ...person });
      console.log(`\nAdded ${person.email} as a member.`);
      return;
    }

    if ((await householdCount(db)) > 0) {
      throw new UserSetupError(
        "A household already exists. To add another person to it, run with --add-member",
      );
    }
    console.log("Creating the household and its first member (the owner).");
    const householdName = await promptLine("Household name: ");
    const person = await promptPerson();
    await createHouseholdWithOwner(db, { householdName, ...person });
    console.log(`\nCreated household "${householdName}" with owner ${person.email}.`);
  } finally {
    await db.$disconnect();
  }
}

async function promptPerson() {
  const name = await promptLine("Your name: ");
  const email = await promptLine("Email (used to sign in): ");
  const password = await promptHidden("Password (12+ characters, hidden): ");
  const confirmation = await promptHidden("Repeat password: ");
  if (password !== confirmation) throw new UserSetupError("The passwords did not match");
  return { name, email, password };
}

main().catch((error: unknown) => {
  // Setup errors are written to be shown; anything else gets a generic line so
  // no unexpected internals (connection strings, SQL) are printed.
  if (error instanceof UserSetupError) console.error(`Error: ${error.message}`);
  else if (error instanceof Error && error.message === "Cancelled") console.error("Cancelled.");
  else if (error instanceof Error && error.message.startsWith("This command needs")) console.error(error.message);
  else console.error("Error: could not complete the request. Check that the database is running and migrated.");
  process.exitCode = 1;
});
