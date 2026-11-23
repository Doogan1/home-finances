import { answerClearQuestion } from "@/features/forecast/did-it-clear";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import { occurrenceTarget, ruleErrorResponse, type OccurrenceContext } from "@/features/rules/http";
import { clearAnswerInput } from "@/features/rules/input";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Answers "Did it clear?" for one occurrence in one account: Cleared or Still pending.
export async function POST(request: Request, context: OccurrenceContext) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const target = await occurrenceTarget(context);
  if (target instanceof Response) return target;
  const body = await readJson(request, clearAnswerInput);
  if (!body) return badRequest();
  const { householdId, userId } = authorization.context;
  try {
    await answerClearQuestion(getDb(), householdId, userId, target.ruleId, target.scheduledOn, body, {
      environment: getPlaidEnvironment(),
    });
    return jsonNoStore({ ok: true });
  } catch (error) {
    return ruleErrorResponse(error, "occurrences.clear");
  }
}
