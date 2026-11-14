import "server-only";
import { z } from "zod";
import { jsonNoStore } from "@/lib/http";
import {
  PlaidFlowError,
  PlaidNotConfiguredError,
  PlaidProviderError,
  type PlaidErrorKind,
} from "./types";

/**
 * Shared plumbing for the Plaid route handlers: uncacheable JSON responses,
 * strict body parsing, and the one place where internal failures become the
 * (deliberately vague) messages a browser may see.
 */

// Generic JSON helpers live in src/lib/http.ts; re-exported for existing callers.
export { badRequest, jsonNoStore, readJson } from "@/lib/http";

type Mapped = { status: number; error: string; message: string };

const FLOW: Record<Exclude<PlaidFlowError["code"], "provider_error">, Mapped> = {
  attempt_not_found: { status: 404, error: "attempt_not_found", message: "That connection attempt was not found. Start again." },
  attempt_expired: { status: 410, error: "attempt_expired", message: "That connection attempt expired. Start again." },
  attempt_used: { status: 409, error: "attempt_used", message: "That connection attempt was already used. Start again." },
  connection_not_found: { status: 404, error: "connection_not_found", message: "That connection was not found." },
  invalid_public_token: { status: 400, error: "invalid_public_token", message: "Plaid did not accept that sign-in. Start again." },
  duplicate_item: { status: 409, error: "duplicate_item", message: "That bank login is already connected." },
  sync_in_progress: { status: 409, error: "sync_in_progress", message: "A sync is already running for this bank. Give it a moment." },
  sync_throttled: { status: 429, error: "sync_throttled", message: "Synced very recently. Wait a little before syncing again." },
  reconnect_required: { status: 409, error: "reconnect_required", message: "The bank needs you to sign in again. Use Reconnect first." },
  not_disconnected: { status: 409, error: "not_disconnected", message: "Disconnect this bank first. Only a disconnected bank's saved history can be deleted." },
  persistence_failed: { status: 500, error: "persistence_failed", message: "The bank was reached but the connection could not be saved. Start again; nothing was kept." },
  token_unreadable: { status: 500, error: "token_unreadable", message: "The stored connection key can no longer be read. Reconnect this bank." },
};

const PROVIDER: Record<PlaidErrorKind, Mapped> = {
  rate_limited: { status: 429, error: "rate_limited", message: "Plaid is rate limiting requests. Wait a minute and try again." },
  timeout: { status: 504, error: "timeout", message: "Plaid did not answer in time. Start again in a moment." },
  unavailable: { status: 503, error: "unavailable", message: "Plaid or the bank is temporarily unavailable. Try again later." },
  missing_entitlement: { status: 422, error: "missing_entitlement", message: "This Plaid account is not enabled for the requested product." },
  login_required: { status: 409, error: "login_required", message: "The bank needs you to sign in again." },
  misconfigured: { status: 503, error: "plaid_misconfigured", message: "The Plaid credentials were rejected. Check the server configuration." },
  invalid_public_token: { status: 400, error: "invalid_public_token", message: "Plaid did not accept that sign-in. Start again." },
  mutation_during_pagination: { status: 503, error: "sync_conflict", message: "The bank's data changed while it was being read. Try again." },
  item_gone: { status: 404, error: "connection_not_found", message: "Plaid no longer has that connection." },
  unknown: { status: 502, error: "provider_error", message: "Plaid returned an unexpected error. Try again later." },
};

/**
 * Turn any thrown value into a safe response. Only codes and categories are
 * logged (never messages from the SDK, never request data), and the browser
 * only ever receives the fixed text above.
 */
export function plaidErrorResponse(error: unknown, route: string): Response {
  if (error instanceof PlaidNotConfiguredError) {
    return jsonNoStore(
      { error: "plaid_not_configured", message: "Plaid is not configured on this server." },
      503,
    );
  }

  if (error instanceof PlaidFlowError) {
    const provider = error.provider;
    const mapped = error.code === "provider_error" ? PROVIDER[provider?.kind ?? "unknown"] : FLOW[error.code];
    console.error(`[plaid] ${route} failed`, {
      code: error.code,
      kind: provider?.kind,
      providerCode: provider?.code,
      requestId: provider?.requestId,
    });
    const body: Record<string, unknown> = { error: mapped.error, message: mapped.message };
    if (error.retryAfterSeconds !== undefined) body.retryAfterSeconds = error.retryAfterSeconds;
    const response = jsonNoStore(body, mapped.status);
    if (error.retryAfterSeconds !== undefined) response.headers.set("retry-after", String(error.retryAfterSeconds));
    return response;
  }

  if (error instanceof PlaidProviderError) {
    const mapped = PROVIDER[error.kind];
    console.error(`[plaid] ${route} failed`, { kind: error.kind, providerCode: error.code, requestId: error.requestId });
    return jsonNoStore({ error: mapped.error, message: mapped.message }, mapped.status);
  }

  console.error(`[plaid] ${route} failed unexpectedly`, { name: error instanceof Error ? error.name : typeof error });
  return jsonNoStore({ error: "internal_error", message: "Something went wrong." }, 500);
}

/** The `[id]` segment as a uuid, or null. A malformed id is just "not found". */
export async function connectionIdFrom(context: { params: Promise<{ id: string }> }): Promise<string | null> {
  const parsed = z.uuid().safeParse((await context.params).id);
  return parsed.success ? parsed.data : null;
}
