"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PlaidLinkButton } from "./plaid-link";
import { postJson } from "./plaid-api";
import { RefreshConnectionButton } from "./refresh-connection-button";

type Status = "PENDING" | "ACTIVE" | "LOGIN_REQUIRED" | "ERROR" | "DISCONNECTED";
type Panel = "none" | "disconnect" | "delete";

/**
 * The buttons for one connection card. What is offered depends on its state:
 * a connected bank can be refreshed, reconnected or disconnected; a
 * disconnected one can only have its saved history deleted, behind a separate
 * typed confirmation. Anything destructive explains what it will and will not do
 * before the person commits.
 */
export function ConnectionActions({
  connectionId,
  status,
  institutionName,
  savedAccounts,
  attachedNames,
  plaidConfigured,
}: {
  connectionId: string;
  status: Status;
  institutionName: string;
  savedAccounts: number;
  attachedNames: string[];
  plaidConfigured: boolean;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>("none");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  async function run(url: string, body: unknown) {
    setWorking(true);
    setError(null);
    const result = await postJson<unknown>(url, body);
    setWorking(false);
    if (!result.ok) return setError(result.message);
    setPanel("none");
    setTyped("");
    router.refresh();
  }

  function open(next: Panel) {
    setError(null);
    setTyped("");
    setPanel(next);
  }

  if (status === "DISCONNECTED") {
    return (
      <div>
        {panel === "delete" ? (
          <div className="confirm">
            <p>
              <strong>Delete saved history for {institutionName}?</strong> This permanently removes{" "}
              {savedAccounts > 0
                ? `its ${savedAccounts} saved ${savedAccounts === 1 ? "account" : "accounts"}, every balance recorded for them`
                : "every balance recorded for its accounts"}{" "}
              and any saved transactions. Bills those transactions were matched to lose those payments from their history. It
              cannot be undone. Your other connections are not affected.
            </p>
            {attachedNames.length > 0 && (
              <p>
                {attachedNames.join(", ")} {attachedNames.length === 1 ? "goes" : "go"} back to being entered by hand:
                the balances you typed, and the bills and income that use {attachedNames.length === 1 ? "it" : "them"}, are
                kept; the balances and transactions from {institutionName} are deleted.
              </p>
            )}
            <label>
              Type <code>DELETE</code> to confirm{" "}
              <input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
            </label>{" "}
            <button
              type="button"
              disabled={typed !== "DELETE" || working}
              onClick={() => run(`/api/plaid/connections/${connectionId}/delete-history`, { confirm: "DELETE" })}
            >
              {working ? "Deleting…" : "Delete permanently"}
            </button>{" "}
            <button type="button" disabled={working} onClick={() => open("none")}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => open("delete")}>
            Delete saved history…
          </button>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      {panel === "disconnect" ? (
        <div className="confirm">
          <p>
            <strong>Disconnect {institutionName}?</strong> This asks Plaid to remove the connection, so no new
            balances will be fetched and Plaid stops billing for it. Accounts and balances already saved stay in this
            app until you delete them. To use the bank again you would connect it as a new bank.
          </p>
          {attachedNames.length > 0 && (
            <p>
              {attachedNames.join(", ")} {attachedNames.length === 1 ? "stays" : "stay"} in the forecast; enter{" "}
              {attachedNames.length === 1 ? "its" : "their"} balances by hand from then on.
            </p>
          )}
          <button type="button" disabled={working} onClick={() => run(`/api/plaid/connections/${connectionId}/disconnect`, {})}>
            {working ? "Disconnecting…" : "Yes, disconnect"}
          </button>{" "}
          <button type="button" disabled={working} onClick={() => open("none")}>
            Cancel
          </button>
        </div>
      ) : (
        <span className="actions">
          {status !== "LOGIN_REQUIRED" && (
            <RefreshConnectionButton
              connectionId={connectionId}
              label={status === "PENDING" ? "Fetch accounts" : "Refresh accounts"}
            />
          )}
          {plaidConfigured && (
            <PlaidLinkButton startUrl={`/api/plaid/connections/${connectionId}/reconnect`} label="Reconnect" />
          )}
          {plaidConfigured && status === "ACTIVE" && (
            // The supported way to add (or drop) accounts. Linking the bank again as a
            // new connection would use another trial slot and, at PNC, invalidate this one.
            <PlaidLinkButton
              startUrl={`/api/plaid/connections/${connectionId}/reconnect`}
              startBody={{ selectAccounts: true }}
              label="Add or change accounts"
              doneText="Accounts updated."
            />
          )}
          <button type="button" onClick={() => open("disconnect")}>
            Disconnect…
          </button>
        </span>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
