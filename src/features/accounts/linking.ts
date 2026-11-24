import "server-only";
import type { ItemStatus, Prisma } from "@/generated/prisma/client";

/**
 * What an account may do, given how it is linked to a bank. Three kinds:
 *
 * - hand-entered: no Plaid link;
 * - attached: hand-entered, with an account from a connected bank attached to it
 *   (`attachedAt` set; it carries that account's Plaid key, so refreshes and
 *   syncs update it);
 * - bank-only: came from a connection and was never attached.
 *
 * Hand-entered and attached accounts belong to the person: they can be renamed
 * and used by bills and income. An attached account's balances come from the
 * bank until its connection is disconnected; then it takes typed balances again.
 */

export type LinkFacts = { plaidItemId: string | null; attachedAt: Date | null };

export function isHandManaged(account: LinkFacts): boolean {
  return account.plaidItemId === null || account.attachedAt !== null;
}

/** The Prisma filter for isHandManaged. */
export const HAND_MANAGED = { OR: [{ plaidItemId: null }, { attachedAt: { not: null } }] } satisfies Prisma.AccountWhereInput;

export function acceptsManualBalances(account: LinkFacts & { connectionStatus: ItemStatus | null }): boolean {
  if (account.plaidItemId === null) return true;
  return account.attachedAt !== null && account.connectionStatus === "DISCONNECTED";
}

export type AttachKind = "depository" | "credit";

/** Checking and savings attach to checking and savings; a card to a card. Loans and investments never attach. */
export function attachKind(type: string): AttachKind | null {
  return type === "depository" || type === "credit" ? type : null;
}

export type AttachCandidate = { id: string; name: string; type: string; archivedAt: Date | null; plaidItemId: string | null };

/** The hand-entered accounts a bank account of `bankType` may be attached to: open, unlinked, same kind. */
export function attachTargets<T extends AttachCandidate>(bankType: string, candidates: readonly T[]): T[] {
  const kind = attachKind(bankType);
  if (kind === null) return [];
  return candidates.filter((c) => c.archivedAt === null && c.plaidItemId === null && attachKind(c.type) === kind);
}
