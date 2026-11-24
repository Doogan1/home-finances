import "server-only";
import { jsonNoStore } from "@/lib/http";
import { AccountInputError, type AccountErrorCode } from "./manual";

const MAPPED: Record<AccountErrorCode, { status: number; message: string }> = {
  account_not_found: { status: 404, message: "That account was not found." },
  not_manual: { status: 409, message: "That account comes from a connected bank, so it can't be changed this way." },
  archived: { status: 409, message: "That account is archived." },
  time_zone_required: { status: 409, message: "Set your household's time zone first." },
  future_date: { status: 400, message: "That date is in the future." },
  in_use: { status: 409, message: "That account is still used by a bill or income." },
  already_linked: { status: 409, message: "That account already gets its balances from a bank." },
  bank_account_not_found: { status: 404, message: "That bank account was not found." },
  not_plaid: { status: 409, message: "That account was entered by hand, not brought in from a bank." },
  already_attached: { status: 409, message: "That account already has a bank account attached." },
  connection_disconnected: { status: 409, message: "That bank is disconnected, so its accounts can't be attached." },
  not_reported: { status: 409, message: "The bank no longer reports this account, so it can't be attached." },
  kind_mismatch: {
    status: 409,
    message: "Those are different kinds of account. Attach checking or savings to checking or savings, and a card to a card.",
  },
  bank_account_in_use: { status: 409, message: "That bank account is used by a bill or income." },
};

/** Refusals that name the household's own rules when there are any. */
const NAMED: Partial<Record<AccountErrorCode, (names: string) => string>> = {
  in_use: (names) => `That account is still used by ${names}. Stop or change those first.`,
  bank_account_in_use: (names) => `That bank account is used by ${names}. Change those first.`,
};

/** Messages are fixed, apart from the household's own rule names; internal errors are logged by name, never by content. */
export function accountErrorResponse(error: unknown, route: string): Response {
  if (error instanceof AccountInputError) {
    const mapped = MAPPED[error.code];
    const named = NAMED[error.code];
    const message = named && error.ruleNames.length > 0 ? named(error.ruleNames.join(", ")) : mapped.message;
    return jsonNoStore({ error: error.code, message }, mapped.status);
  }
  console.error(`[accounts] ${route} failed unexpectedly`, { name: error instanceof Error ? error.name : typeof error });
  return jsonNoStore({ error: "internal_error", message: "Something went wrong." }, 500);
}

export const accountNotFound = () => accountErrorResponse(new AccountInputError("account_not_found"), "lookup");
