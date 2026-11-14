import { z } from "zod";
import { ruleErrorResponse, ruleNotFound, versionNotFound } from "@/features/rules/http";
import { editVersionInput } from "@/features/rules/input";
import { editRuleVersion } from "@/features/rules/service";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Edit this version: fix a version in place, without making history.
export async function POST(request: Request, context: { params: Promise<{ id: string; versionId: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const { id: rawId, versionId: rawVersionId } = await context.params;
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return ruleNotFound();
  const versionId = z.uuid().safeParse(rawVersionId);
  if (!versionId.success) return versionNotFound();
  const body = await readJson(request, editVersionInput);
  if (!body) return badRequest();
  try {
    await editRuleVersion(getDb(), authorization.context.householdId, id.data, versionId.data, body);
    return jsonNoStore({ ok: true });
  } catch (error) {
    return ruleErrorResponse(error, "rules.versions.update");
  }
}
