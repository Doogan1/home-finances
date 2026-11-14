import { accountErrorResponse } from "@/features/accounts/http";
import { recordBalancesInput } from "@/features/accounts/input";
import { recordBalances } from "@/features/accounts/manual";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Records the balances of several hand-entered accounts as of one date, all or nothing.
export async function POST(request: Request) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const body = await readJson(request, recordBalancesInput);
  if (!body) return badRequest();
  try {
    return jsonNoStore(await recordBalances(getDb(), authorization.context.householdId, body));
  } catch (error) {
    return accountErrorResponse(error, "balances.record");
  }
}
