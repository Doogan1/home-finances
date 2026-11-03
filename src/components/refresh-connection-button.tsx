"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Asks the server to re-fetch one connection's accounts from Plaid. Always an
// explicit click: viewing a page never calls Plaid.
export function RefreshConnectionButton({ connectionId, label }: { connectionId: string; label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/plaid/connections/${connectionId}/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? "Could not refresh. Try again.");
      }
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <span>
      <button type="button" onClick={refresh} disabled={pending}>
        {pending ? "Working…" : label}
      </button>
      {error && (
        <span role="alert" className="form-error">
          {" "}
          {error}
        </span>
      )}
    </span>
  );
}
