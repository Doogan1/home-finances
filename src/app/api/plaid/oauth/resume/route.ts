import { z } from "zod";
import { getLinkDeps } from "@/features/plaid/deps";
import { badRequest, jsonNoStore, plaidErrorResponse, readJson } from "@/features/plaid/http";
import { resumeLinkAttempt } from "@/features/plaid/link";
import { authorizeMutation } from "@/lib/auth/household";

const bodySchema = z.strictObject({ attemptId: z.uuid() });

// For banks that use OAuth: after the bank sends the person back to
// /plaid/oauth, that page needs the SAME link token Link was first opened with.
// Only the browser session that started the attempt can have it, and only
// while the attempt is open.
export async function POST(request: Request) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;
  const { householdId, sessionId } = authorization.context;

  const body = await readJson(request, bodySchema);
  if (!body) return badRequest();

  try {
    return jsonNoStore(await resumeLinkAttempt(getLinkDeps(), householdId, sessionId, body.attemptId));
  } catch (error) {
    return plaidErrorResponse(error, "oauth-resume");
  }
}
