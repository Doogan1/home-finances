import { z } from "zod";
import { ruleErrorResponse, ruleNotFound } from "@/features/rules/http";
import { updateRuleInput } from "@/features/rules/input";
import { updateRule } from "@/features/rules/service";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Renames a rule, or changes its category, notes or the card it pays.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return ruleNotFound();
  const body = await readJson(request, updateRuleInput);
  if (!body) return badRequest();
  try {
    await updateRule(getDb(), authorization.context.householdId, id.data, body);
    return jsonNoStore({ ok: true });
  } catch (error) {
    return ruleErrorResponse(error, "rules.update");
  }
}
