# Transaction sync (Task 6)

Transactions are fetched **only when asked**: the **Sync now** button on the
Transactions page, or `npm run sync` on the command line. Opening a page never
contacts Plaid. Both entry points call the same service,
`src/features/plaid/sync.ts` (`syncItem`), so they behave identically.

## What a sync guarantees

A sync either applies a complete batch and moves the cursor, or changes nothing.
There is no state in which the stored transactions and the saved cursor disagree.

```text
LEASE    take the connection (one sync at a time)
STAGE    read every page from the saved cursor into memory
COMMIT   one database transaction: prove nothing changed, apply the batch,
         move the cursor
```

1. **Lease.** A sync stores a random token and an expiry (5 minutes) on the
   connection with one atomic update. A second sync while it is held is refused
   (`sync_in_progress`) and creates no run. If a worker crashes, its lease simply
   expires and the next sync takes over. A running sync extends its lease on
   every page.
2. **Stage.** Pages are read outside any database transaction (a transaction
   held open across network calls would hold locks while waiting). The batch is
   bounded: at most 100 pages of 200 updates; beyond that the sync is refused
   (`sync_too_large`) instead of risking memory or a huge transaction.
   - A **transient error** on a page (timeout, outage, rate limit) is retried up
     to 3 times with a short, growing pause.
   - If Plaid says the data **changed while paging**
     (`TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`) the whole batch is thrown
     away and read again from the cursor the sync *started* with, up to 3
     restarts, as Plaid instructs.
   - Errors retrying cannot fix (bad credentials, sign-in needed) stop at once.
3. **Commit.** First a single guarded `UPDATE` proves that the lease token is
   still ours **and** the cursor and its version are what the sync started from;
   only then are the changes written and the cursor advanced, all in the same
   transaction. A worker that stalled past its lease, or a cursor that moved, makes
   the guard fail (`lease_lost`, `cursor_conflict`) and the whole commit is
   discarded. Any database error rolls back every row and the cursor
   (`persistence_failed`).

## How data is stored

- **Amounts keep Plaid's sign and exact decimals.** Positive = money out of the
  account (purchases, payments); negative = money in (deposits, refunds). The page
  labels each amount *out* or *in*.
- **Added and modified are idempotent upserts** keyed by Plaid's transaction id,
  so re-applying a batch changes nothing the second time.
- **Removed transactions are kept but marked** (`removedAt`) and excluded from
  every list, so nothing can count them.
- **Pending → posted.** A posted transaction records the pending one it replaces
  (`pendingProviderTransactionId`), and that pending row is retired in the same
  commit **whether or not Plaid also lists it as removed in that batch**, so the
  charge is never counted twice.
- Only the description, merchant name, amount, currency, dates and pending flag
  are kept: no raw provider payloads, locations or counterparties.
- Accounts that appear in a sync for the first time are created; a transaction
  for an account nobody has described rolls the whole batch back
  (`unknown_account`).

## "No data yet" is not an error

Straight after linking, Plaid may not have transactions ready. It then answers
with empty results and an **empty cursor** rather than an error. The sync records
a successful run with Plaid's status (`NOT_READY`), **does not save the empty
cursor** (that would claim "synced up to nothing"), and the page says *No
transactions yet — it is not an error; sync again shortly.* Plaid checks banks
roughly one to four times a day, so a sync that finds nothing new is normal.

## Reading the result

| Page says | Meaning |
| --- | --- |
| Up to date | Last run succeeded; counts shown |
| Recent transactions loaded | Newest data is in; older history still arriving |
| No transactions yet | Plaid has nothing ready (normal just after linking) |
| Last sync failed | Nothing was changed; the plain-language reason and the last good sync are shown |
| Sign-in needed | The bank wants a new login; use **Reconnect** on Connections first |

Failures never move the cursor or touch stored data. Raw provider codes are not
shown.

## Throttling

The button allows one sync per connection per minute (the server enforces it and
answers `429` with `Retry-After`). The command line is not throttled. Neither can
overlap another sync of the same connection, because of the lease.

## Command line

```bash
docker compose exec app npm run sync                 # list connections and when each last synced
docker compose exec app npm run sync -- <id>         # sync one connection
docker compose exec app npm run sync -- --all        # sync every connected bank
```

Exit status is non-zero if any sync failed. The command resolves the household
with an explicit lookup (it works when there is exactly one) and is not a web
path.

## Inspecting and recovering

Recent runs:

```bash
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-home_finances}" -c "
  select r.\"startedAt\", r.status, r.\"errorCode\", r.\"providerStatus\",
         r.\"addedCount\" a, r.\"modifiedCount\" m, r.\"removedCount\" d, r.\"pageCount\" pages
  from \"SyncRun\" r order by r.\"startedAt\" desc limit 10"'
```

A lease needs no cleanup: it expires on its own after five minutes. A `RUNNING`
run older than that is a sync whose worker died; it can be ignored (the next
sync starts clean from the saved cursor) or closed:

```sql
update "SyncRun" set status = 'FAILED', "errorCode" = 'abandoned', "finishedAt" = now()
 where status = 'RUNNING' and "startedAt" < now() - interval '15 minutes';
```

To make a connection re-read its entire history (for example after a restore),
clear its cursor; the next sync starts from the beginning and the idempotent
upserts make that safe:

```sql
update "PlaidItem" set "syncCursor" = null where id = '<connection id>';
```

## Limits and not covered

- One sync applies at most 20,000 updates in a single commit. Larger histories
  are refused rather than risking the database; there is no chunked catch-up yet.
- No webhooks and no scheduler: nothing syncs unless you ask. (Plaid's
  `SYNC_UPDATES_AVAILABLE` webhook needs a publicly reachable address.)
- `/transactions/refresh` (ask Plaid to check the bank sooner) is not used; it can
  carry extra cost and was not verified.
- Spending reports and categories are out of scope; the page lists recent
  transactions only (the latest 200).
