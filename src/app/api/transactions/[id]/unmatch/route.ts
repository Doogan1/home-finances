import { undoMatchInput, paymentErrorResponse, transactionTarget, type TransactionContext } from "@/features/payments/http";
import { undoMatch } from "@/features/payments/service";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Undoes a match, whoever made it. The occurrence goes back to what it was.
export async function POST(request: Request, context: TransactionContext) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const transactionId = await transactionTarget(context);
  if (transactionId instanceof Response) return transactionId;
  const body = await readJson(request, undoMatchInput);
  if (!body) return badRequest();
  const { householdId } = authorization.context;
  try {
    await undoMatch(getDb(), householdId, transactionId);
    return jsonNoStore({ ok: true });
  } catch (error) {
    return paymentErrorResponse(error, "transactions.unmatch");
  }
}
