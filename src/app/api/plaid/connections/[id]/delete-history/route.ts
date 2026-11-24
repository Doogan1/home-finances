import { z } from "zod";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import { badRequest, connectionIdFrom, jsonNoStore, plaidErrorResponse, readJson } from "@/features/plaid/http";
import { deleteConnectionHistory } from "@/features/plaid/lifecycle";
import { PlaidFlowError } from "@/features/plaid/types";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";

// Deleting saved history cannot be undone, so the caller must send the exact
// word the person was asked to type, and the connection must already be
// disconnected. It never calls Plaid, so it works without Plaid credentials.
const bodySchema = z.strictObject({ confirm: z.literal("DELETE") });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const id = await connectionIdFrom(context);
  if (!id) return plaidErrorResponse(new PlaidFlowError("connection_not_found"), "delete-history");

  if (!(await readJson(request, bodySchema))) return badRequest();

  try {
    const result = await deleteConnectionHistory(
      { db: getDb(), environment: getPlaidEnvironment() },
      authorization.context.householdId,
      id,
    );
    return jsonNoStore({ deleted: true, ...result });
  } catch (error) {
    return plaidErrorResponse(error, "delete-history");
  }
}
