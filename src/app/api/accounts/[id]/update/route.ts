import { z } from "zod";
import { accountErrorResponse, accountNotFound } from "@/features/accounts/http";
import { updateAccountInput } from "@/features/accounts/input";
import { updateAccount } from "@/features/accounts/manual";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Changes an account's name (hand-entered only), owner label, cushion or forecast setting.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return accountNotFound();
  const body = await readJson(request, updateAccountInput);
  if (!body) return badRequest();
  try {
    await updateAccount(getDb(), authorization.context.householdId, id.data, body);
    return jsonNoStore({ ok: true });
  } catch (error) {
    return accountErrorResponse(error, "accounts.update");
  }
}
