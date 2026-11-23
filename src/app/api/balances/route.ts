import { accountErrorResponse } from "@/features/accounts/http";
import { recordBalancesInput } from "@/features/accounts/input";
import { recordBalances } from "@/features/accounts/manual";
import { openClearQuestions } from "@/features/forecast/did-it-clear";
import { getPlaidEnvironment } from "@/features/plaid/environment";
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
    const db = getDb();
    const { householdId } = authorization.context;
    const recorded = await recordBalances(db, householdId, body);
    // The form offers the "Did it clear?" questions next when there are any.
    const questions = (await openClearQuestions(db, householdId, { environment: getPlaidEnvironment() })).length;
    return jsonNoStore({ ...recorded, questions });
  } catch (error) {
    return accountErrorResponse(error, "balances.record");
  }
}
