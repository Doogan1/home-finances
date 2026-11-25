"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Summary = {
  status: "SUCCEEDED" | "FAILED";
  added: number;
  modified: number;
  removed: number;
  errorCode: string | null;
  providerStatus: string | null;
  matched?: number;
};
type Notice = { tone: "ok" | "warn" | "error"; text: string };

/**
 * "Sync now" for one connection. Always an explicit click; viewing a page never
 * calls Plaid. The server decides whether it may run (one sync at a time, and
 * at most one a minute from here) and says why in plain words when it may not.
 */
export function SyncButton({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function sync() {
    setPending(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/plaid/connections/${connectionId}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await response.json().catch(() => ({}))) as Partial<Summary> & { message?: string };
      if (!response.ok) {
        setNotice({ tone: "error", text: body.message ?? "Could not sync. Try again." });
      } else if (body.status === "FAILED") {
        // The details are on the page after the refresh (they come from the saved run).
        setNotice({ tone: "error", text: "The sync did not complete, so nothing was changed." });
      } else if (body.providerStatus === "NOT_READY") {
        setNotice({ tone: "warn", text: "Plaid has no transactions for this bank yet. Try again in a few minutes." });
      } else {
        setNotice({
          tone: "ok",
          text:
            `Synced: ${body.added ?? 0} new, ${body.modified ?? 0} changed, ${body.removed ?? 0} removed.` +
            (body.matched ? ` Matched ${body.matched} to bills and income.` : ""),
        });
      }
    } catch {
      setNotice({ tone: "error", text: "Could not reach the server. Try again." });
    } finally {
      setPending(false);
      router.refresh();
    }
  }

  return (
    <span>
      <button type="button" onClick={sync} disabled={pending}>
        {pending ? "Syncing…" : "Sync now"}
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
