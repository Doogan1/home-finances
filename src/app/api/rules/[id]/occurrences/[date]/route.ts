import { occurrenceTarget, ruleErrorResponse, type OccurrenceContext } from "@/features/rules/http";
import { occurrenceEditInput } from "@/features/rules/input";
import { saveOccurrenceEdit } from "@/features/rules/occurrence-edits";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Saves the person's edit of one occurrence: its status, a confirmed amount, a move, a note.
export async function POST(request: Request, context: OccurrenceContext) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const target = await occurrenceTarget(context);
  if (target instanceof Response) return target;
  const body = await readJson(request, occurrenceEditInput);
  if (!body) return badRequest();
  const { householdId, userId } = authorization.context;
  try {
    const result = await saveOccurrenceEdit(getDb(), householdId, userId, target.ruleId, target.scheduledOn, body);
    return jsonNoStore({ ok: true, ...result });
  } catch (error) {
    return ruleErrorResponse(error, "occurrences.save");
  }
}
