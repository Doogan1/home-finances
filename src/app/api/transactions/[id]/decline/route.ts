import { declineMatchInput, paymentErrorResponse, transactionTarget, type TransactionContext } from "@/features/payments/http";
import { declineMatch } from "@/features/payments/service";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// "No, this is not that bill": the pair is not proposed again.
export async function POST(request: Request, context: TransactionContext) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const transactionId = await transactionTarget(context);
  if (transactionId instanceof Response) return transactionId;
  const body = await readJson(request, declineMatchInput);
  if (!body) return badRequest();
  const { householdId } = authorization.context;
  try {
    await declineMatch(getDb(), householdId, transactionId, body.ruleId);
    return jsonNoStore({ ok: true });
  } catch (error) {
    return paymentErrorResponse(error, "transactions.decline");
  }
}
