# Connecting a bank (Task 4)

How a Plaid Sandbox connection is made, what is stored, and what to do when a
step fails. Sandbox only for now: no real institutions are contacted.

## The flow

```text
browser                           our server                         Plaid
   │  POST /api/plaid/link-token      │                                │
   │ ────────────────────────────────▶│ authorize (origin + session)   │
   │                                  │ create LinkAttempt (PENDING)   │
   │                                  │ /link/token/create ───────────▶│
   │ ◀──── { attemptId, linkToken } ──│                                │
   │  open Plaid Link (bank login happens between browser and Plaid)   │
   │  POST /api/plaid/exchange { attemptId, publicToken }              │
   │ ────────────────────────────────▶│ authorize; claim attempt       │
   │                                  │ /item/public_token/exchange ──▶│
   │                                  │ encrypt token, save Item       │
   │                                  │ /accounts/get ────────────────▶│
   │ ◀──── { connectionId, status } ──│ save accounts + balances       │
```

- The **link token** and **public token** are short-lived and single-purpose.
  The long-lived **access token** exists only on the server, encrypted with
  `TOKEN_ENCRYPTION_KEY` and bound to its environment and Plaid Item id. It is
  never sent to the browser, logged, or included in an error.
- Link is requested for **Transactions only**, with **90 days** of history
  recorded on the attempt. Auth is not requested just to read balances.
  Balances come from `/accounts/get`; a fresh-balance call (`/accounts/balance/get`)
  is deliberately not used yet.
- Institution and account details the browser reports are ignored. Everything
  stored comes from Plaid's own `/accounts/get` response.
- `client_user_id` sent to Plaid is the household id: stable, opaque, and not
  personal data.

## Protections

| Concern | How it is handled |
| --- | --- |
| Anonymous or cross-site calls | `authorizeMutation` runs first in every route: Origin check, then session. Plaid is never called before it passes. |
| Another household's data | Attempts and connections are looked up by the signed-in household (and, for attempts, browser session). Someone else's is "not found". |
| Replay / double submit | The attempt moves `PENDING → EXCHANGING` in one atomic update; of two simultaneous requests exactly one wins. A used, expired or other-session attempt never reaches Plaid. |
| Duplicate rows | Unique keys in the database: `(environment, plaidItemId)` for Items, `(plaidItemId, externalAccountId)` for accounts. |
| Error leakage | SDK errors carry the request (including secrets). They are reduced to a category, Plaid's error code and request id before leaving `client.ts`; the browser only sees fixed messages. |
| Caching | Plaid routes answer `Cache-Control: no-store`; pages are rendered per request. |

## Link attempt states

| Status | Meaning |
| --- | --- |
| `PENDING` | Link token issued; waiting for the person to finish at their bank. Expires after 30 minutes. |
| `EXCHANGING` | A request has claimed the attempt and is talking to Plaid. Normally lasts a second or two. |
| `COMPLETED` | Item saved with its encrypted token. (Fetching accounts is a separate, retryable step.) |
| `FAILED` | Ended with a safe `errorCode` and **no Item at Plaid** was left usable by us (for example `INVALID_PUBLIC_TOKEN`, `attempt_expired`, `duplicate_item`). |
| `NEEDS_RECONCILIATION` | The exchange may have succeeded at Plaid but we could not confirm or save it. The public token is **never retried**. |

A connection (`PlaidItem`) is `PENDING` until accounts have been fetched once.
A failed first fetch is not a failed link: use **Fetch accounts** on the
Connections page, which calls `/accounts/get` again without touching the
(consumed) public token.

## Recovery and orphan cleanup

Look for attempts that need attention (run from the project folder):

```bash
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-home_finances}" -c "
  select id, status, \"errorCode\", \"providerItemId\", \"createdAt\"
  from \"LinkAttempt\"
  where status = '"'"'NEEDS_RECONCILIATION'"'"'
     or (status = '"'"'EXCHANGING'"'"' and \"createdAt\" < now() - interval '"'"'15 minutes'"'"')
  order by \"createdAt\" desc"'
```

`EXCHANGING` for more than a few minutes means the server stopped mid-flow
(crash or restart); treat it like `NEEDS_RECONCILIATION`.

For each one:

1. **Is there a connection?** If `PlaidItem` has a row whose `plaidItemId` equals
   the attempt's `providerItemId`, the link actually worked. Nothing to clean up;
   mark the attempt `COMPLETED`.
2. **No connection, `providerItemId` present.** An Item exists at Plaid that this
   app holds no token for. The app already tried `/item/remove` when the save
   failed; if that also failed the Item is orphaned. In Sandbox this is
   harmless (test data, no cost). With real credentials, remove it from the Plaid
   Dashboard (Items) so it stops being billed, then mark the attempt `FAILED`.
3. **No `providerItemId` at all** (the timeout case): the exchange may or may not
   have happened. Check the Plaid Dashboard for a new Item around `createdAt`.
   If there is one, treat it as case 2. If not, mark the attempt `FAILED`.
4. Ask the person to connect the bank again. Do not try to reuse the old public
   token; it can be exchanged only once.

Closing an attempt once reviewed:

```sql
update "LinkAttempt" set status = 'FAILED', "errorCode" = 'reconciled' where id = '<attempt id>';
```

## Reconnecting (Link update mode)

A connection shows **Sign-in needed** when Plaid answers `ITEM_LOGIN_REQUIRED`
(or the related expiry codes) while accounts are being fetched. Because there are
no webhooks yet, this is discovered when someone presses **Refresh accounts**.

**Reconnect** opens Link in *update mode* on the same connection: the server
decrypts the stored access token and asks Plaid for an update-mode link token
(no products, no history request, since the Item already has them). Per Plaid,
the access token does **not** change in update mode, so nothing is exchanged: the
browser still reports Link's success to `/api/plaid/exchange`, but for a
`RECONNECT` attempt the server ignores the public token, closes the attempt and
re-fetches accounts. That clears the warning, or restores it if the bank still
refuses. Reconnect is offered for any connection that still has a token, so
consent can also be refreshed before it lapses.

Reconnect attempts have the same protections as new ones: bound to household and
browser session, 30-minute expiry, claimed once, replay-proof.

To try it in Sandbox without waiting for a real expiry:

```bash
docker compose exec app npm run plaid:sandbox                      # list connection ids
docker compose exec app npm run plaid:sandbox -- reset-login <id>  # Sandbox-only: make the bank demand a sign-in
```

then press **Refresh accounts** on that connection (it turns to *Sign-in needed*)
and **Reconnect**.

## Disconnecting

**Disconnect…** asks for confirmation (it explains what happens), then:

1. calls Plaid's `/item/remove`, which invalidates the access token and, per
   Plaid, is what ends billing for Transactions;
2. erases the stored (encrypted) access token, marks the connection
   **Disconnected**, and marks its accounts as no longer reported.

Saved accounts, balance observations and any transactions are **kept**. They
remain visible (marked "Disconnected · history kept") until you delete them.

- **If Plaid cannot be reached**, nothing changes locally (the token is kept) so
  the same button can simply be pressed again. The error code is shown as a plain
  message on the card.
- **If Plaid says it no longer knows the Item** (`ITEM_NOT_FOUND` /
  `INVALID_ACCESS_TOKEN`), or the stored token can no longer be decrypted (for
  example the encryption key was lost), the connection is disconnected locally
  but flagged *removal not confirmed*. Plaid's documentation does not say whether
  `/item/remove` is idempotent, and `INVALID_ACCESS_TOKEN` can also mean the
  token belongs to a different environment, so the app cannot prove the Item is
  gone. Check the Plaid Dashboard (Items) so billing stops.
- Disconnected connections can no longer be refreshed or reconnected. To use the
  bank again, connect it as a new bank.

## Deleting saved history

A separate step, available only for a **disconnected** connection:
**Delete saved history…** explains what will be removed (its accounts, every
balance recorded for them, any transactions), requires typing `DELETE`, and
cannot be undone. The server re-checks that the connection is disconnected as
part of the delete itself, and other connections are never touched. Link attempts
that referred to it are kept (without the link) for the audit trail.

## OAuth banks and `PLAID_REDIRECT_URI`

Some banks send the person to their own website to approve access and then back
to the app. Plaid Link handles that, but the app must provide a **redirect page**
and tell Plaid its address.

1. **Choose the address.** For Sandbox on this machine:
   `http://localhost:3000/plaid/oauth`. Plaid allows plain `http://localhost`
   **only in Sandbox**; every real deployment needs an `https://` address, with no
   query string or fragment.
2. **Register it.** Add exactly that address to *Allowed redirect URIs* in the
   Plaid Dashboard (Developers → API). Plaid rejects a link token whose
   `redirect_uri` is not on that list.
3. **Configure it.** Set `PLAID_REDIRECT_URI` in `.env` and recreate the app
   container. The app validates the value at startup (https, or localhost in
   Sandbox; no query or fragment).
4. With it set, every link token carries the redirect URI.

How the return trip works (`src/components/oauth-resume.tsx`):

- Before Link opens, the browser remembers the attempt's id (just an opaque id)
  in `sessionStorage`.
- When the bank returns the person to `/plaid/oauth?oauth_state_id=…`, the page
  asks `POST /api/plaid/oauth/resume` for the attempt's **original link token**.
  Plaid requires the same token, so the server keeps it encrypted
  (`LinkAttempt.linkTokenCiphertext`, bound to the attempt) and returns it only
  to the browser session that started the attempt, only while the attempt is open.
  It is erased the moment the attempt completes, fails or expires.
- The page reopens Link with that token and the full return address as
  `receivedRedirectUri`, then finishes through the normal exchange route.

Keeping the callback address private: the dev server's request log ignores
`/plaid/oauth` (`logging.incomingRequests` in `next.config.ts`), the app never
logs it, and the page is served with `Referrer-Policy: no-referrer` so the
address is not sent to other sites.

**Redirect addresses in production (from Plaid's docs).** They must be https (Sandbox alone allows `http://localhost`), registered in the Dashboard, and have no query string or fragment. The docs do not say whether `https://localhost` is accepted in production; the Dashboard accepted it when tried, and [local-https.md](local-https.md) shows how to serve it. Trial plans can use OAuth institutions, and PNC and Chase have extra requirements that do not apply on a trial. Plaid does not document, in the pages checked, whether desktop browsers use a popup or a full-page redirect in production, so the return page handles both: in the main window it resumes the attempt; if it is loaded in a popup it does nothing and leaves the attempt to the window that opened it.

**What has and has not been exercised.** Per Plaid, Sandbox in a desktop browser
opens Link in a pop-up, so the redirect page is not used; it is used by webviews
and mobile browsers. The page is covered by automated tests (guards, expiry,
safe failure) and the server side by integration tests, but a full real redirect
round trip needs Plaid's *Platypus OAuth Bank* with a simulated webview user
agent, and real banks need an `https` address. This was not tried against Plaid.
A public tunnel is never opened by the app or its tools; if a real bank needs
one, that is a decision for you to make.

## Adding or changing accounts

*Add or change accounts* (Connections page) opens Link in update mode with account
selection switched on (`update.account_selection_enabled`). It is the supported way to
share more accounts, or fewer, with an existing connection. Linking the same bank
again as a new connection is the wrong way: it uses another trial slot, and at PNC
it invalidates the first connection. After it completes, the account list is
re-fetched; accounts no longer shared appear as "Not reported by bank" with their
history kept.

## Not yet covered

Transaction sync is documented in [transaction-sync.md](transaction-sync.md). There is no automatic reconciliation job, no webhook
handling (so "sign-in needed" is only noticed on an explicit refresh), and
link-token creation is not rate limited beyond Plaid's own limits.

## Trying it in Sandbox

1. Put your Sandbox `PLAID_CLIENT_ID` and `PLAID_SECRET` in `.env`, then
   `docker compose up -d --force-recreate app` (Compose reads `.env` only when a
   container is created).
2. Sign in, open **Connections**, choose **Connect a bank**.
3. Pick *First Platypus Bank* (or any non-OAuth test institution) and use
   Plaid's published Sandbox credentials, `user_good` / `pass_good`. These work
   only in Sandbox.
4. You should land back on Connections with a *Connected* card, and **Accounts**
   should list the test accounts with the time each balance was observed.
