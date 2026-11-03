import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Household-scoped reads of Plaid connections (Items).
 *
 * Every lookup takes the household id that came from the signed-in session
 * (`requireHousehold()`), never from the browser, and puts it in the query
 * itself. An Item belonging to another household simply is not found; callers
 * cannot tell "not yours" from "does not exist". The access token ciphertext and
 * sync cursor are omitted so they cannot leak by accident into a page or
 * response; code that needs them must ask for them explicitly.
 */
export function findHouseholdPlaidItem(db: PrismaClient, householdId: string, itemId: string) {
  return db.plaidItem.findFirst({
    where: { id: itemId, householdId },
    omit: { accessTokenCiphertext: true, syncCursor: true },
  });
}
