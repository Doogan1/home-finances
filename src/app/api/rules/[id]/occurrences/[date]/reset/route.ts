import { occurrenceTarget, ruleErrorResponse, type OccurrenceContext } from "@/features/rules/http";
import { resetOccurrenceInput } from "@/features/rules/input";
import { resetOccurrenceEdit } from "@/features/rules/occurrence-edits";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Reset to rule: deletes this occurrence's edit.
export async function POST(request: Request, context: OccurrenceContext) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const target = await occurrenceTarget(context);
  if (target instanceof Response) return target;
  const body = await readJson(request, resetOccurrenceInput);
  if (!body) return badRequest();
  try {
    const result = await resetOccurrenceEdit(getDb(), authorization.context.householdId, target.ruleId, target.scheduledOn);
    return jsonNoStore({ ok: true, ...result });
  } catch (error) {
    return ruleErrorResponse(error, "occurrences.reset");
  }
}
