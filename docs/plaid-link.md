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

## Not yet covered

Reconnect (update mode), disconnect, OAuth banks and the `PLAID_REDIRECT_URI`
setting arrive in Task 5; transaction sync in Task 6. There is no automatic
reconciliation job, no webhook handling, and link-token creation is not rate
limited beyond Plaid's own limits.

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
