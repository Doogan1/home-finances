import { z } from "zod";
import { getLinkDeps } from "@/features/plaid/deps";
import { badRequest, jsonNoStore, plaidErrorResponse, readJson } from "@/features/plaid/http";
import { exchangeLinkAttempt } from "@/features/plaid/link";
import { authorizeMutation } from "@/lib/auth/household";

// Strict: unknown fields (such as a household id the browser has no business
// supplying) are rejected rather than ignored.
const bodySchema = z.strictObject({
  attemptId: z.uuid(),
  publicToken: z.string().min(1).max(500),
});

// Called by the browser when Plaid Link succeeds. The public token is traded for
// an access token that is encrypted and stored server-side; the response is only
// a connection id and a status, never any token.
export async function POST(request: Request) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;
  const { householdId, sessionId } = authorization.context;

  const body = await readJson(request, bodySchema);
  if (!body) return badRequest();

  try {
    const result = await exchangeLinkAttempt(
      getLinkDeps(),
      householdId,
      sessionId,
      body.attemptId,
      body.publicToken,
    );
    return jsonNoStore(result);
  } catch (error) {
    return plaidErrorResponse(error, "exchange");
  }
}
