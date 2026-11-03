"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from "react-plaid-link";

type Phase = "idle" | "starting" | "linking" | "saving";
type Notice = { tone: "ok" | "warn" | "error"; text: string } | null;

type ApiError = { message?: string };

async function postJson<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as T & ApiError;
    if (response.ok) return { ok: true, data };
    return { ok: false, message: data.message ?? "Something went wrong. Try again." };
  } catch {
    return { ok: false, message: "Could not reach the server. Check your connection and try again." };
  }
}

/**
 * Opens Plaid Link and finishes the connection on the server.
 *
 * The browser only ever holds two short-lived, single-purpose values: the link
 * token (to open Link) and, after the person signs in at their bank, a public
 * token (handed straight to our server, which exchanges it). The long-lived
 * access token is created and kept encrypted on the server and never reaches
 * this component.
 */
export function PlaidLinkButton() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<Notice>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const attemptId = useRef<string | null>(null);

  const reset = useCallback(() => {
    // A link token is single-use, so a fresh one is fetched for the next try.
    setLinkToken(null);
    attemptId.current = null;
    setPhase("idle");
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken) => {
      const id = attemptId.current;
      setLinkToken(null);
      if (!id) {
        reset();
        return setNotice({ tone: "error", text: "That connection attempt was lost. Start again." });
      }
      setPhase("saving");
      const result = await postJson<{ status: string }>("/api/plaid/exchange", { attemptId: id, publicToken });
      reset();
      if (!result.ok) return setNotice({ tone: "error", text: result.message });
      setNotice(
        result.data.status === "ACTIVE"
          ? { tone: "ok", text: "Bank connected." }
          : { tone: "warn", text: "Bank connected, but its accounts could not be loaded yet. Use “Fetch accounts” below." },
      );
      router.refresh();
    },
    [reset, router],
  );

  const onExit = useCallback<PlaidLinkOnExit>(
    (error) => {
      reset();
      if (!error) return setNotice({ tone: "warn", text: "Cancelled. Nothing was connected." });
      setNotice({
        tone: "error",
        text:
          error.error_code === "INVALID_LINK_TOKEN"
            ? "That session expired. Start again."
            : "Plaid could not complete the connection. Try again in a moment.",
      });
    },
    [reset],
  );

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess, onExit });

  // Link can only be opened once its script has loaded for the new token.
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  async function start() {
    setNotice(null);
    setPhase("starting");
    const result = await postJson<{ attemptId: string; linkToken: string }>("/api/plaid/link-token", {});
    if (!result.ok) {
      reset();
      return setNotice({ tone: "error", text: result.message });
    }
    attemptId.current = result.data.attemptId;
    setPhase("linking");
    setLinkToken(result.data.linkToken);
  }

  const busy = phase !== "idle";
  const label = { idle: "Connect a bank", starting: "Preparing…", linking: "Waiting for Plaid…", saving: "Saving connection…" }[phase];

  return (
    <div>
      <button type="button" onClick={start} disabled={busy}>
        {label}
      </button>
      {notice && (
        <p role="status" className={`notice notice-${notice.tone}`}>
          {notice.text}
        </p>
      )}
    </div>
  );
}
