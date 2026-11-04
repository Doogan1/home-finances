"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from "react-plaid-link";
import { attemptMemory, postJson } from "./plaid-api";

type Phase = "idle" | "starting" | "linking" | "saving";
type Notice = { tone: "ok" | "warn" | "error"; text: string } | null;

/**
 * Opens Plaid Link and finishes the connection on the server.
 *
 * Used for two things, chosen by `startUrl`: connecting a new bank (the default)
 * and reconnecting an existing one (Link in update mode).
 *
 * The browser only ever holds two short-lived, single-purpose values: the link
 * token (to open Link) and, after the person signs in at their bank, a public
 * token (handed straight to our server). The long-lived access token is created
 * and kept encrypted on the server and never reaches this component.
 *
 * For banks that use OAuth, Link sends the whole page to the bank and back. The
 * attempt id is remembered for that trip so /plaid/oauth can resume the attempt.
 */
export function PlaidLinkButton({
  startUrl = "/api/plaid/link-token",
  label = "Connect a bank",
}: {
  startUrl?: string;
  label?: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<Notice>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const attemptId = useRef<string | null>(null);

  const reset = useCallback(() => {
    // A link token is single-use, so a fresh one is fetched for the next try.
    setLinkToken(null);
    attemptId.current = null;
    attemptMemory.clear();
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
          ? { tone: "ok", text: "Connected." }
          : result.data.status === "LOGIN_REQUIRED"
            ? { tone: "warn", text: "The bank still needs a sign-in. Try Reconnect again." }
            : { tone: "warn", text: "Connected, but accounts could not be loaded yet. Use “Fetch accounts”." },
      );
      router.refresh();
    },
    [reset, router],
  );

  const onExit = useCallback<PlaidLinkOnExit>(
    (error) => {
      reset();
      if (!error) return setNotice({ tone: "warn", text: "Cancelled. Nothing was changed." });
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
    const result = await postJson<{ attemptId: string; linkToken: string }>(startUrl, {});
    if (!result.ok) {
      reset();
      return setNotice({ tone: "error", text: result.message });
    }
    attemptId.current = result.data.attemptId;
    attemptMemory.save(result.data.attemptId);
    setPhase("linking");
    setLinkToken(result.data.linkToken);
  }

  const busy = phase !== "idle";
  const text = { idle: label, starting: "Preparing…", linking: "Waiting for Plaid…", saving: "Saving…" }[phase];

  return (
    <span>
      <button type="button" onClick={start} disabled={busy}>
        {text}
      </button>
      {notice && (
        <span role="status" className={`notice notice-${notice.tone}`}>
          {" "}
          {notice.text}
        </span>
      )}
    </span>
  );
}
