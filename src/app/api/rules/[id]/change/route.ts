import { z } from "zod";
import { ruleErrorResponse, ruleNotFound } from "@/features/rules/http";
import { changeFromInput } from "@/features/rules/input";
import { changeRuleFrom } from "@/features/rules/service";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Change from a date: the latest version ends the day before, and a copy with the edits starts.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return ruleNotFound();
  const body = await readJson(request, changeFromInput);
  if (!body) return badRequest();
  try {
    const { versionId } = await changeRuleFrom(getDb(), authorization.context.householdId, id.data, body);
    return jsonNoStore({ ok: true, versionId });
  } catch (error) {
    return ruleErrorResponse(error, "rules.change");
  }
}
