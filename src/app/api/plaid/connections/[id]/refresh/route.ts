import { z } from "zod";
import { refreshItemAccounts } from "@/features/plaid/accounts";
import { getLinkDeps } from "@/features/plaid/deps";
import { jsonNoStore, plaidErrorResponse } from "@/features/plaid/http";
import { PlaidFlowError } from "@/features/plaid/types";
import { authorizeMutation } from "@/lib/auth/household";

// Re-fetches a connection's accounts from Plaid. This is the retry for a link
// whose first account fetch failed, and a manual refresh. It is an explicit
// user action (never triggered by viewing a page). The connection is looked up
// by the signed-in household, not by anything in the URL alone.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return plaidErrorResponse(new PlaidFlowError("connection_not_found"), "refresh");

  try {
    return jsonNoStore(await refreshItemAccounts(getLinkDeps(), authorization.context.householdId, id.data));
  } catch (error) {
    return plaidErrorResponse(error, "refresh");
  }
}
