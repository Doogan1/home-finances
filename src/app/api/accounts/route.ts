import { accountErrorResponse } from "@/features/accounts/http";
import { createAccountInput } from "@/features/accounts/input";
import { createManualAccount } from "@/features/accounts/manual";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Adds an account entered by hand (one not linked through Plaid).
export async function POST(request: Request) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const body = await readJson(request, createAccountInput);
  if (!body) return badRequest();
  try {
    const { id } = await createManualAccount(getDb(), authorization.context.householdId, body);
    return jsonNoStore({ id }, 201);
  } catch (error) {
    return accountErrorResponse(error, "accounts.create");
  }
}
