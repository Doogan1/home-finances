import { getLinkDeps } from "@/features/plaid/deps";
import { connectionIdFrom, jsonNoStore, plaidErrorResponse } from "@/features/plaid/http";
import { disconnectConnection } from "@/features/plaid/lifecycle";
import { PlaidFlowError } from "@/features/plaid/types";
import { authorizeMutation } from "@/lib/auth/household";

// Removes the connection at Plaid and erases its stored access token. Saved
// accounts and balances are kept; deleting them is a separate, confirmed step.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const id = await connectionIdFrom(context);
  if (!id) return plaidErrorResponse(new PlaidFlowError("connection_not_found"), "disconnect");

  try {
    return jsonNoStore(await disconnectConnection(getLinkDeps(), authorization.context.householdId, id));
  } catch (error) {
    return plaidErrorResponse(error, "disconnect");
  }
}
