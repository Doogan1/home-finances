import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { PasswordPolicyError, assertPasswordPolicy, hashPassword } from "@/lib/auth/password";

/**
 * Creating users is deliberately a command-line operation, not a web feature
 * (registration is closed). These functions are the only way accounts come into
 * existence; they take an explicit database client and household so nothing
 * here can be mistaken for, or reused as, a web authorization path.
 *
 * Better Auth stores a password login as a User plus an AuthAccount row with
 * providerId "credential" and the hash in `password`; we write exactly that.
 */

export class UserSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserSetupError";
  }
}

export type NewPerson = { name: string; email: string; password: string };

const personSchema = z.object({
  name: z.string().trim().min(1, "A name is required").max(100),
  email: z.email("A valid email address is required").max(254).transform((e) => e.toLowerCase()),
});

function validate(person: NewPerson): { name: string; email: string } {
  const parsed = personSchema.safeParse({ name: person.name, email: person.email });
  if (!parsed.success) {
    throw new UserSetupError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  try {
    assertPasswordPolicy(person.password);
  } catch (error) {
    if (error instanceof PasswordPolicyError) throw new UserSetupError(error.message);
    throw error;
  }
  return parsed.data;
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

async function createUser(tx: Tx, person: { name: string; email: string }, passwordHash: string) {
  const existing = await tx.user.findUnique({ where: { email: person.email }, select: { id: true } });
  if (existing) throw new UserSetupError("A user with that email already exists");

  const user = await tx.user.create({ data: { name: person.name, email: person.email } });
  await tx.authAccount.create({
    data: { userId: user.id, accountId: user.id, providerId: "credential", password: passwordHash },
  });
  return user;
}

export async function createHouseholdWithOwner(
  db: PrismaClient,
  input: NewPerson & { householdName: string },
): Promise<{ userId: string; householdId: string }> {
  const person = validate(input);
  const householdName = input.householdName.trim();
  if (!householdName) throw new UserSetupError("A household name is required");
  const passwordHash = await hashPassword(input.password);

  return db.$transaction(async (tx) => {
    const household = await tx.household.create({ data: { name: householdName } });
    const user = await createUser(tx, person, passwordHash);
    await tx.membership.create({
      data: { userId: user.id, householdId: household.id, role: "OWNER" },
    });
    return { userId: user.id, householdId: household.id };
  });
}

export async function addMember(
  db: PrismaClient,
  input: NewPerson & { householdId: string },
): Promise<{ userId: string; householdId: string }> {
  const person = validate(input);
  const passwordHash = await hashPassword(input.password);

  return db.$transaction(async (tx) => {
    const household = await tx.household.findUnique({
      where: { id: input.householdId },
      select: { id: true },
    });
    if (!household) throw new UserSetupError("That household does not exist");
    const user = await createUser(tx, person, passwordHash);
    await tx.membership.create({
      data: { userId: user.id, householdId: household.id, role: "MEMBER" },
    });
    return { userId: user.id, householdId: household.id };
  });
}

/**
 * Explicit household lookup for CLI use. Succeeds only when there is exactly
 * one household, so a command can never silently pick the wrong one.
 */
export async function findSoleHousehold(db: PrismaClient): Promise<{ id: string; name: string }> {
  const households = await db.household.findMany({ select: { id: true, name: true }, take: 2 });
  if (households.length === 0) {
    throw new UserSetupError("No household exists yet. Run the bootstrap command without --add-member first");
  }
  if (households.length > 1) {
    throw new UserSetupError("More than one household exists; this command only supports a single household");
  }
  return households[0];
}

export async function householdCount(db: PrismaClient): Promise<number> {
  return db.household.count();
}
