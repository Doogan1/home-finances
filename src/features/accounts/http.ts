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
};

/** Fixed messages only; internal errors are logged by name, never by content. */
export function accountErrorResponse(error: unknown, route: string): Response {
  if (error instanceof AccountInputError) {
    const mapped = MAPPED[error.code];
    const message =
      error.code === "in_use" && error.ruleNames.length > 0
        ? `That account is still used by ${error.ruleNames.join(", ")}. Stop or change those first.`
        : mapped.message;
    return jsonNoStore({ error: error.code, message }, mapped.status);
  }
  console.error(`[accounts] ${route} failed unexpectedly`, { name: error instanceof Error ? error.name : typeof error });
  return jsonNoStore({ error: "internal_error", message: "Something went wrong." }, 500);
}

export const accountNotFound = () => accountErrorResponse(new AccountInputError("account_not_found"), "lookup");
