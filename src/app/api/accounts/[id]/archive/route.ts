import { z } from "zod";
import { accountErrorResponse, accountNotFound } from "@/features/accounts/http";
import { archiveManualAccount } from "@/features/accounts/manual";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Archives a hand-entered account. Its balances stay as history.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return accountNotFound();
  if (!(await readJson(request, z.strictObject({})))) return badRequest();
  try {
    await archiveManualAccount(getDb(), authorization.context.householdId, id.data);
    return jsonNoStore({ ok: true });
  } catch (error) {
    return accountErrorResponse(error, "accounts.archive");
  }
}
