import { getPlaidEnvironment } from "@/features/plaid/environment";
import { confirmMatchInput, paymentErrorResponse, transactionTarget, type TransactionContext } from "@/features/payments/http";
import { confirmMatch } from "@/features/payments/service";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// The person says this transaction paid this bill (or was this income), on a due date or with none.
export async function POST(request: Request, context: TransactionContext) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const transactionId = await transactionTarget(context);
  if (transactionId instanceof Response) return transactionId;
  const body = await readJson(request, confirmMatchInput);
  if (!body) return badRequest();
  const { householdId, userId } = authorization.context;
  try {
    await confirmMatch(getDb(), householdId, userId, transactionId, body, { environment: getPlaidEnvironment() });
    return jsonNoStore({ ok: true });
  } catch (error) {
    return paymentErrorResponse(error, "transactions.match");
  }
}
