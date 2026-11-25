import { z } from "zod";
import { attachBankAccount } from "@/features/accounts/attach";
import { accountErrorResponse, accountNotFound } from "@/features/accounts/http";
import { attachAccountInput } from "@/features/accounts/input";
import { runMatchingQuietly } from "@/features/payments/service";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Attaches an account from a connected bank to the hand-entered account in the URL.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return accountNotFound();
  const body = await readJson(request, attachAccountInput);
  if (!body) return badRequest();
  try {
    const { householdId } = authorization.context;
    const environment = getPlaidEnvironment();
    const result = await attachBankAccount(getDb(), householdId, id.data, body, { environment });
    // The bank's transactions are now in an account bills can use.
    await runMatchingQuietly(getDb(), householdId, { environment });
    return jsonNoStore({ ok: true, ...result });
  } catch (error) {
    return accountErrorResponse(error, "accounts.attach");
  }
}
