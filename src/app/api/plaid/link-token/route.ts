import { getLinkDeps } from "@/features/plaid/deps";
import { jsonNoStore, plaidErrorResponse } from "@/features/plaid/http";
import { createLinkAttempt } from "@/features/plaid/link";
import { authorizeMutation } from "@/lib/auth/household";

// Starts a connection attempt: records it (bound to this household and browser
// session) and returns the link token the browser needs to open Plaid Link.
export async function POST(request: Request) {
  // Origin check and session first; nothing below runs, and Plaid is never
  // called, for an anonymous or cross-site request.
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;
  const { householdId, sessionId } = authorization.context;

  try {
    return jsonNoStore(await createLinkAttempt(getLinkDeps(), householdId, sessionId));
  } catch (error) {
    return plaidErrorResponse(error, "link-token");
  }
}
