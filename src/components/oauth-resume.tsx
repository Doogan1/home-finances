"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from "react-plaid-link";
import { attemptMemory, postJson } from "./plaid-api";

type State =
  | { phase: "loading" }
  | { phase: "linking" }
  | { phase: "saving" }
  | { phase: "failed"; message: string };

const subscribeToNothing = () => () => {};
// The full address of this page, including the state id the bank appended.
// Link needs it verbatim; it is never logged, stored or sent anywhere else.
const readHref = () => window.location.href;
const noHref = () => null;

/**
 * The page a bank sends the person back to after OAuth. It reopens Plaid Link
 * with the SAME link token the attempt started with (fetched from our server,
 * which only gives it to the browser session that started the attempt) and the
 * full return address, so Link can pick up where the bank left off.
 */
export function OAuthResume() {
  const router = useRouter();
  const receivedRedirectUri = useSyncExternalStore(subscribeToNothing, readHref, noHref);
  const [state, setState] = useState<State>({ phase: "loading" });
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const attemptId = useRef<string | null>(null);

  useEffect(() => {
    async function resume() {
      const id = attemptMemory.read();
      if (!id) {
        return setState({
          phase: "failed",
          message: "This connection can no longer be resumed in this browser tab.",
        });
      }
      attemptId.current = id;
      const result = await postJson<{ linkToken: string }>("/api/plaid/oauth/resume", { attemptId: id });
      if (!result.ok) {
        attemptMemory.clear();
        return setState({ phase: "failed", message: result.message });
      }
      setLinkToken(result.data.linkToken);
    }
    void resume();
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken) => {
      const id = attemptId.current;
      setLinkToken(null);
      setState({ phase: "saving" });
      const result = id
        ? await postJson("/api/plaid/exchange", { attemptId: id, publicToken })
        : ({ ok: false, message: "That connection attempt was lost. Start again." } as const);
      attemptMemory.clear();
      if (!result.ok) return setState({ phase: "failed", message: result.message });
      router.replace("/connections");
      router.refresh();
    },
    [router],
  );

  const onExit = useCallback<PlaidLinkOnExit>((error) => {
    attemptMemory.clear();
    setLinkToken(null);
    setState({
      phase: "failed",
      message: error ? "Plaid could not complete the connection." : "Cancelled. Nothing was changed.",
    });
  }, []);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    receivedRedirectUri: receivedRedirectUri ?? undefined,
    onSuccess,
    onExit,
  });

  useEffect(() => {
    if (linkToken && ready && receivedRedirectUri) open();
  }, [linkToken, ready, receivedRedirectUri, open]);

  if (state.phase === "failed") {
    return (
      <>
        <p role="alert" className="form-error">
          {state.message}
        </p>
        <p>
          <Link href="/connections">Back to Connections</Link> and start again.
        </p>
      </>
    );
  }
  return <p className="muted">{state.phase === "saving" ? "Saving your connection…" : "Resuming your bank connection…"}</p>;
}
