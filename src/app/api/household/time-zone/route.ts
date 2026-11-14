import { accountErrorResponse } from "@/features/accounts/http";
import { timeZoneInput } from "@/features/accounts/input";
import { setHouseholdTimeZone } from "@/features/accounts/manual";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Sets the household's time zone, which decides what "today" is.
export async function POST(request: Request) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const body = await readJson(request, timeZoneInput);
  if (!body) return badRequest();
  try {
    await setHouseholdTimeZone(getDb(), authorization.context.householdId, body.timeZone);
    return jsonNoStore({ ok: true });
  } catch (error) {
    return accountErrorResponse(error, "household.timeZone");
  }
}
