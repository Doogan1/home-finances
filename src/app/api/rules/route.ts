import { ruleErrorResponse } from "@/features/rules/http";
import { createRuleInput } from "@/features/rules/input";
import { createRule } from "@/features/rules/service";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Adds a bill or an income stream, with its first version.
export async function POST(request: Request) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const body = await readJson(request, createRuleInput);
  if (!body) return badRequest();
  try {
    const { id } = await createRule(getDb(), authorization.context.householdId, body);
    return jsonNoStore({ id }, 201);
  } catch (error) {
    return ruleErrorResponse(error, "rules.create");
  }
}
