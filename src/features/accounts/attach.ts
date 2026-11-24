import "server-only";
import type { PlaidEnvironment, PrismaClient } from "@/generated/prisma/client";
import type { AttachAccountInput } from "./input";
import { attachKind, type AttachCandidate } from "./linking";
import { AccountInputError } from "./manual";

/**
 * Attaching an account from a connected bank (the "bank account") to the
 * hand-entered account it really is (the "target"). The target keeps its id,
 * name, owner, cushion, forecast setting, rules and typed balances; it takes
 * over the bank account's Plaid key and bank details, and the bank's saved
 * balances and transactions move onto it. The bank account's own row is then
 * deleted, so refreshes and syncs, which look accounts up by the key, update the
 * target from then on.
 *
 * One transaction. Both rows are locked first, in id order (so two attaches
 * never deadlock), and re-read under the lock: of two simultaneous attaches of
 * one bank account, the second finds it gone. Everything is filtered by the
 * household from the session; a bank account from another household or another
 * Plaid environment is "not found".
 */

export type AttachResult = { accountId: string; movedTransactions: number; movedBalances: number };

export async function attachBankAccount(
  db: PrismaClient,
  householdId: string,
  targetId: string,
  input: AttachAccountInput,
  options: { environment: PlaidEnvironment; now?: Date },
): Promise<AttachResult> {
  const now = options.now ?? new Date();
  const bankId = input.plaidAccountId;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`
      select id from "Account"
      where id in (${targetId}::uuid, ${bankId}::uuid) and "householdId" = ${householdId}::uuid
      order by id
      for update`;

    const target = await tx.account.findFirst({
      where: { id: targetId, householdId },
      select: { id: true, type: true, archivedAt: true, plaidItemId: true },
    });
    if (!target) throw new AccountInputError("account_not_found");
    if (target.archivedAt) throw new AccountInputError("archived");
    if (target.plaidItemId !== null) throw new AccountInputError("already_linked");

    const bank = await tx.account.findFirst({
      where: { id: bankId, householdId },
      select: {
        id: true,
        type: true,
        subtype: true,
        mask: true,
        officialName: true,
        active: true,
        unavailableSince: true,
        plaidItemId: true,
        externalAccountId: true,
        attachedAt: true,
        plaidItem: { select: { environment: true, status: true } },
      },
    });
    if (!bank) throw new AccountInputError("bank_account_not_found");
    if (bank.plaidItemId === null || bank.externalAccountId === null || bank.plaidItem === null) {
      throw new AccountInputError("not_plaid");
    }
    if (bank.plaidItem.environment !== options.environment) throw new AccountInputError("bank_account_not_found");
    if (bank.attachedAt !== null) throw new AccountInputError("already_attached");
    if (bank.plaidItem.status === "DISCONNECTED") throw new AccountInputError("connection_disconnected");
    if (!bank.active) throw new AccountInputError("not_reported");
    const kind = attachKind(target.type);
    if (kind === null || attachKind(bank.type) !== kind) throw new AccountInputError("kind_mismatch");

    // Rules may only use the person's own accounts, but older rows could point at a bank-only one.
    const users = await tx.rule.findMany({
      where: {
        householdId,
        OR: [{ paysAccountId: bank.id }, { versions: { some: { allocations: { some: { accountId: bank.id } } } } }],
      },
      select: { name: true },
      orderBy: { name: "asc" },
    });
    if (users.length > 0) throw new AccountInputError("bank_account_in_use", users.map((rule) => rule.name));

    // 1. Free the [plaidItemId, externalAccountId] key. The database requires
    //    both Plaid fields or neither, so the bank row gets a placeholder that
    //    is unique to it; the row is deleted below.
    await tx.account.update({ where: { id: bank.id }, data: { externalAccountId: `attached:${bank.id}` } });
    // 2. The target takes the key and the bank's details.
    await tx.account.update({
      where: { id: target.id },
      data: {
        plaidItemId: bank.plaidItemId,
        externalAccountId: bank.externalAccountId,
        attachedAt: now,
        mask: bank.mask,
        officialName: bank.officialName,
        subtype: bank.subtype,
        active: bank.active,
        unavailableSince: bank.unavailableSince,
      },
    });
    // 3. Transactions reference (account, connection); the target now has both.
    const transactions = await tx.transaction.updateMany({ where: { accountId: bank.id }, data: { accountId: target.id } });
    // 4. The bank's balances. A bank-only account has no typed ones.
    const balances = await tx.balanceSnapshot.updateMany({
      where: { accountId: bank.id, source: { not: "MANUAL" } },
      data: { accountId: target.id },
    });
    // 5. The bank account's own row goes.
    await tx.account.delete({ where: { id: bank.id } });

    return { accountId: target.id, movedTransactions: transactions.count, movedBalances: balances.count };
  });
}

/** Hand-entered accounts that could take a bank account: open and unlinked, by name. attachTargets narrows them by kind. */
export function listAttachCandidates(db: PrismaClient, householdId: string): Promise<AttachCandidate[]> {
  return db.account.findMany({
    where: { householdId, plaidItemId: null, archivedAt: null },
    select: { id: true, name: true, type: true, archivedAt: true, plaidItemId: true },
    orderBy: { name: "asc" },
  });
}
