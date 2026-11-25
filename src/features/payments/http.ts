import "server-only";
import { z } from "zod";
import { jsonNoStore } from "@/lib/http";
import { isoDateField } from "@/lib/zod-fields";
import { PaymentInputError, type PaymentErrorCode } from "./service";

/** Request bodies, statuses and fixed messages for the payment routes. */

export const confirmMatchInput = z.strictObject({ ruleId: z.uuid(), scheduledOn: isoDateField.nullable() });
export const declineMatchInput = z.strictObject({ ruleId: z.uuid() });
export const undoMatchInput = z.strictObject({});

const STATUS: Record<PaymentErrorCode, number> = {
  transaction_not_found: 404,
  rule_not_found: 404,
  occurrence_not_found: 404,
  already_matched: 409,
  not_matched: 409,
  rule_archived: 409,
  wrong_direction: 400,
  wrong_account: 400,
};

export const PAYMENT_MESSAGES: Record<PaymentErrorCode, string> = {
  transaction_not_found: "That transaction was not found. Only posted transactions in your own accounts can be matched.",
  rule_not_found: "That bill or income was not found.",
  occurrence_not_found: "That bill or income has no date then. It may have changed since this page was opened.",
  already_matched: "That transaction is already matched. Undo its match first.",
  not_matched: "That transaction is not matched to anything. Reload to see what changed.",
  rule_archived: "That bill or income is archived.",
  wrong_direction: "Money going out can only pay a bill, and money coming in can only be income.",
  wrong_account: "That transaction is in an account this bill or income does not use.",
};

export function paymentErrorResponse(error: unknown, route: string): Response {
  if (error instanceof PaymentInputError) {
    return jsonNoStore({ error: error.code, message: PAYMENT_MESSAGES[error.code] }, STATUS[error.code]);
  }
  console.error(`[payments] ${route} failed unexpectedly`, { name: error instanceof Error ? error.name : typeof error });
  return jsonNoStore({ error: "internal_error", message: "Something went wrong." }, 500);
}

export type TransactionContext = { params: Promise<{ id: string }> };

/** The transaction named in the address, or the 404 to answer with. */
export async function transactionTarget(context: TransactionContext): Promise<string | Response> {
  const { id } = await context.params;
  return z.uuid().safeParse(id).success ? id : paymentErrorResponse(new PaymentInputError("transaction_not_found"), "lookup");
}
