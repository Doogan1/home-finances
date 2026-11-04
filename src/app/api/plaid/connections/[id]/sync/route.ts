import { getLinkDeps } from "@/features/plaid/deps";
import { connectionIdFrom, jsonNoStore, plaidErrorResponse } from "@/features/plaid/http";
import { MANUAL_SYNC_MIN_INTERVAL_MS, syncItem } from "@/features/plaid/sync";
import { PlaidFlowError } from "@/features/plaid/types";
import { authorizeMutation } from "@/lib/auth/household";

// Syncs one of this household's connections now. An explicit action: viewing a
// page never triggers it. The same service backs `npm run sync`.
//
// A sync that ran but failed (the bank was unreachable, the data changed while
// it was being read, ...) answers 200 with a summary whose status is FAILED, so
// the person sees what happened; the cursor and stored data are untouched. Only
// requests that never started a run (not signed in, unknown connection, one
// sync already running, throttled) get an error status.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const id = await connectionIdFrom(context);
  if (!id) return plaidErrorResponse(new PlaidFlowError("connection_not_found"), "sync");

  try {
    const summary = await syncItem(getLinkDeps(), authorization.context.householdId, id, {
      minIntervalMs: MANUAL_SYNC_MIN_INTERVAL_MS,
    });
    return jsonNoStore(summary);
  } catch (error) {
    return plaidErrorResponse(error, "sync");
  }
}
