import { z } from "zod";
import { getLinkDeps } from "@/features/plaid/deps";
import { badRequest, connectionIdFrom, jsonNoStore, plaidErrorResponse, readJson } from "@/features/plaid/http";
import { deleteConnectionHistory } from "@/features/plaid/lifecycle";
import { PlaidFlowError } from "@/features/plaid/types";
import { authorizeMutation } from "@/lib/auth/household";

// Deleting saved history cannot be undone, so the caller must send the exact
// word the person was asked to type, and the connection must already be
// disconnected.
const bodySchema = z.strictObject({ confirm: z.literal("DELETE") });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const id = await connectionIdFrom(context);
  if (!id) return plaidErrorResponse(new PlaidFlowError("connection_not_found"), "delete-history");

  if (!(await readJson(request, bodySchema))) return badRequest();

  try {
    await deleteConnectionHistory(getLinkDeps(), authorization.context.householdId, id);
    return jsonNoStore({ deleted: true });
  } catch (error) {
    return plaidErrorResponse(error, "delete-history");
  }
}
