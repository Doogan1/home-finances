import { z } from "zod";
import { ruleErrorResponse, ruleNotFound } from "@/features/rules/http";
import { archiveRuleInput } from "@/features/rules/input";
import { archiveRule } from "@/features/rules/service";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Archives a rule. Rules are never deleted, so their versions and per-date edits stay.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return ruleNotFound();
  const body = await readJson(request, archiveRuleInput);
  if (!body) return badRequest();
  try {
    await archiveRule(getDb(), authorization.context.householdId, id.data);
    return jsonNoStore({ ok: true });
  } catch (error) {
    return ruleErrorResponse(error, "rules.archive");
  }
}
