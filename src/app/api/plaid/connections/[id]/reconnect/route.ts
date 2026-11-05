import { z } from "zod";
import { getLinkDeps } from "@/features/plaid/deps";
import { badRequest, connectionIdFrom, jsonNoStore, plaidErrorResponse, readJson } from "@/features/plaid/http";
import { createReconnectAttempt } from "@/features/plaid/lifecycle";
import { PlaidFlowError } from "@/features/plaid/types";
import { authorizeMutation } from "@/lib/auth/household";

// Strict: the only thing the browser may choose is whether to show account selection.
const bodySchema = z.strictObject({ selectAccounts: z.boolean().optional() });

// Starts Plaid Link in update mode for one of this household's connections
// (the bank wants a fresh sign-in, or consent is about to lapse). Returns the
// same shape as a new connection; the browser finishes it through the exchange
// route, which for a reconnect exchanges nothing.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;
  const { householdId, sessionId } = authorization.context;

  const id = await connectionIdFrom(context);
  if (!id) return plaidErrorResponse(new PlaidFlowError("connection_not_found"), "reconnect");

  const body = await readJson(request, bodySchema);
  if (!body) return badRequest();

  try {
    return jsonNoStore(
      await createReconnectAttempt(getLinkDeps(), householdId, sessionId, id, { selectAccounts: body.selectAccounts }),
    );
  } catch (error) {
    return plaidErrorResponse(error, "reconnect");
  }
}
