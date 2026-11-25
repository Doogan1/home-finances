# Running and looking after Home Finances locally

Everything here is written for Docker Desktop on Windows (PowerShell or any
shell) and works the same elsewhere. Nothing in this repository deploys
anything. For the (unapproved, not started) idea of hosting it on the existing
VM, see [future-deployment.md](future-deployment.md).

## At a glance

| I want to… | Run |
| --- | --- |
| Set up from a fresh clone | `npm run setup:env` → `docker compose up --build -d` → `docker compose exec app npm run db:migrate` → `docker compose exec app npm run auth:bootstrap` |
| Open the app | <http://localhost:3000> (always `localhost`, not `127.0.0.1`) |
| Stop / start without losing data | `docker compose down` / `docker compose up -d` |
| See logs | `docker compose logs -f app` (or `db`) |
| Apply new migrations | `docker compose exec app npm run db:migrate`, then `docker compose restart app` |
| Sync transactions | the **Sync now** button, or `docker compose exec app npm run sync -- --all` |
| Add an account by hand | Accounts → **Add an account** |
| Record balances by hand | Accounts → **Update balances** (one date, many accounts) |
| Add a bill or an income stream | Bills & income → **+ Add bill** or **+ Add income** |
| Change a bill or paycheck from a date on (a raise, a new amount) | Open it → **Change from…** (the old version ends the day before) |
| Stop one (leaving a job, cancelling a service) | Open it → **Stop on…**; undo with **Edit this version** and a blank "Ends on" |
| See where each account is heading | Home: the chart shows the last 30 days (grey, from saved balances and bank transactions) and the next 90 days' end-of-day balances, with a dollar scale; tap, drag or use the arrow keys to read a day; when there is more than one account, pick another above it |
| Find out what needs a look | Home → **Needs attention** (payments to confirm, low days, estimates due soon, balances to update, "Did it clear?", fixed bills whose payments differ) |
| Match a bank transaction to a bill or income | Answer **Yes** to "Is this …?" on Home or Transactions, or open the transaction → **Match**. After one Yes for a payee, clear fits are matched for you (marked **Auto**); **Undo match** on the transaction puts the date back |
| Let a bill's estimate follow its real payments | Open it → **Estimate** → **Let the amount vary** (the middle of its last six payments, once there are three) |
| See what was paid in the past | The bill's **Past** table; Register → **Show the past 30 days**; earlier months on the Calendar |
| Import the workbook (once) | [see below](#importing-the-workbook) |
| Back up | `npm run backup` (on the host) |
| Restore (safely, into a separate database) | `npm run restore -- <file>` |
| Rotate the token-encryption key | [see below](#rotating-the-token-encryption-key) |
| Use https locally (needed for real OAuth banks) | [local-https.md](local-https.md) |
| Check readiness for a real bank | `docker compose exec app npm run preflight` |
| Run every check | [see below](#checks-and-tests) |

## What survives a restart

| Thing | Where | Survives `down` / `up` | Survives `down -v` |
| --- | --- | --- | --- |
| Database (accounts, balances, transactions, users) | volume `home-finances_db-data` | yes | **no, deleted** |
| Linux `node_modules` | volume `home-finances_app-node-modules` | yes | no (rebuilt) |
| Next.js build cache | volume `home-finances_app-next` | yes | no (rebuilt) |
| Secrets | `.env` (git-ignored) | yes | yes |
| Backups | `backups/` (git-ignored) | yes | yes |

`docker compose down` is always safe. **`docker compose down -v` deletes the
database volume and everything in it**; never use it as a clean-up shortcut. A
Docker volume is not a backup.

If you change `package.json`, refresh the dependency volume:

```bash
docker compose down
docker volume rm home-finances_app-node-modules
docker compose up --build -d
```

If you change `.env`, recreate the container (Compose only reads `.env` when it
creates one): `docker compose up -d --force-recreate app`.

After a database migration, also run `docker compose restart app`: a running dev
server keeps the database client it started with and fails with "unknown field".

## Checks and tests

| Command | Where | What it proves |
| --- | --- | --- |
| `docker compose exec app npm run lint` / `typecheck` | container | style, types |
| `docker compose exec app npm test` | container | unit tests (config, crypto, formatting, source-tree security rules) |
| `docker compose exec app npm run test:integration` | container | real database, fake Plaid: auth, linking, lifecycle, sync, key rotation, cross-household and CSRF checks |
| `npm run test:e2e` | host | real browser against the dev app (needs `npx playwright install chromium` once) |
| `npm run test:backup` | host | backup → restore round trip on throwaway databases |
| `npm run verify:image` | host | builds the production image, scans it for your secrets, checks it is not root, runs the whole browser suite against it |
| `docker compose exec app npm run build` | container | the production build compiles |

No automated test calls Plaid's API or a bank. (Pages that include Plaid Link load
Plaid's Link script from Plaid's servers in the browser tests, as any browser would;
that script can also report its own errors to Plaid.) Browser tests create a labelled
throwaway user in the development database and delete it afterwards.

## Backups

```bash
npm run backup                           # writes backups/home-finances-<db>-<UTC time>.dump
npm run backup -- --out D:\private\finance-backups
```

What a backup is, and is not:

- A PostgreSQL custom-format dump written by `pg_dump` **inside the database
  container**, streamed straight to a file and then read back to prove it is a
  valid archive. A half-written file is never kept.
- It contains your accounts, balances, transactions, password hashes and the
  **encrypted** bank tokens. It is **not encrypted** itself. Treat it as
  sensitive.
- It does **not** contain `TOKEN_ENCRYPTION_KEY`. Without that key the stored
  tokens are unreadable (you would reconnect each bank); with it, a copy of the
  file is dangerous. Keep them apart ([below](#backing-up-the-encryption-key)).
- Sessions, sign-in counters and verification rows are left out on purpose.
  After a restore everyone signs in again.
- `backups/` and any `*.dump` are ignored by git and by the Docker build.
- It sits on the same machine as the database. It protects against a bad
  migration or a mistake, **not** against losing the computer. Copy dumps
  somewhere else (encrypted) if that matters to you.

### Restoring

```bash
npm run restore -- backups\home-finances-home_finances-20261103T120000Z.dump
```

By default this restores into a **new, separate database**
(`home_finances_restore_<time>`), prints row counts, and says whether its content
is identical to the live database. **The live database is not touched.** Look at
it, then remove it when done:

```bash
docker compose exec db sh -c 'dropdb -U "$POSTGRES_USER" home_finances_restore_20261103t120000z'
```

To make the restored data the live data, use the explicit form. It refuses unless
you repeat the live database's exact name and the app is stopped:

```bash
docker compose stop app
npm run restore -- <file> --target home_finances --replace-live --confirm home_finances
docker compose start app
```

Even then nothing is overwritten in place. The dump is restored into a side
database first; only if that succeeds are the two swapped by renaming, in one
transaction. The database you had stays, renamed `home_finances_replaced_<time>`,
as an instant way back. The command prints how to drop it once you are happy.

### Proving a backup works

`npm run test:backup` backs up a synthetic database, restores it into a second
database, and compares every table's row count and a hash of every row, including
awkward decimals (`12345678901234.5678`, `-9.99`, `0.0001`), `NULL` balances,
non-ASCII text and the stored (still encrypted) token. It also checks that the
live-database protections hold. Do an occasional real one too: restore your latest
backup into a separate database and look at it.

## Encryption keys

Plaid access tokens are encrypted with AES-256-GCM (`src/lib/crypto/tokens.ts`)
using `TOKEN_ENCRYPTION_KEY` from `.env`. Each stored token records which key id
encrypted it (`TOKEN_ENCRYPTION_KEY_ID`, default `v1`).

### Backing up the encryption key

Do this right after `npm run setup:env`, and again after any rotation:

1. Copy the `TOKEN_ENCRYPTION_KEY=` line (and its id) from `.env` into a password
   manager or other restricted place.
2. Keep it **separate from database backups**. A dump plus the key lets anyone
   read your bank tokens; a dump alone cannot, and the key alone is useless.
3. If you lose the key, nothing breaks except stored tokens: each bank shows an
   error and must be reconnected (disconnect, then connect again).

### Rotating the token-encryption key

Rotate if the key may have been exposed, or on a schedule you choose. Banks stay
connected throughout.

1. **Back up the current `.env`** (or at least the current key) and make a
   database backup.
2. Generate a new key:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
3. Edit `.env`, moving the old key into the retired list and putting the new one
   in place with a new id:

   ```text
   TOKEN_ENCRYPTION_KEY=<the NEW key>
   TOKEN_ENCRYPTION_KEY_ID=v2
   TOKEN_ENCRYPTION_RETIRED_KEYS=v1:<the OLD key>
   ```

   (`id:key` pairs, comma separated, for more than one old key. Ids must differ.)
4. `docker compose up -d --force-recreate app`
5. Preview, then re-encrypt:

   ```bash
   docker compose exec app npm run keys:rotate              # dry run, changes nothing
   docker compose exec app npm run keys:rotate -- --apply
   ```

   It reads each token with whichever key wrote it, encrypts it under the new key,
   proves the new value reads back, and writes it only if the row has not changed
   in the meantime. It reports counts and connection ids, never a token or key.
   It is safe to run again.
6. When it reports `could not be decrypted: 0` and `already on current key` equals the
   number of connections, **back up the new key**, then remove
   `TOKEN_ENCRYPTION_RETIRED_KEYS` and recreate the container again. Do not
   remove the old key while any token still needs it.

Link tokens held during an in-progress OAuth attempt (a few minutes at most) are
not re-encrypted; an attempt open across a rotation just has to be restarted.

## Sandbox testing

Everything defaults to Plaid **Sandbox**: fake banks, fake money, no real
institution. With your Sandbox keys in `.env` (`PLAID_CLIENT_ID`, `PLAID_SECRET`,
`PLAID_ENV=sandbox`):

- **Connect**: Connections → *Connect a bank* → *First Platypus Bank* with
  `user_good` / `pass_good` (Plaid's published Sandbox credentials).
- **Sync**: Transactions → *Sync now*, or `docker compose exec app npm run sync -- --all`.
- **Reconnect**: `docker compose exec app npm run plaid:sandbox -- reset-login <id>`
  forces a "sign-in needed" state to repair with *Reconnect*.
- **Disconnect and delete**: disconnecting calls Plaid's `/item/remove`; saved
  history stays until you delete it in a separate, typed-confirmation step.
  Details: [plaid-link.md](plaid-link.md).
- **OAuth banks** need a registered redirect address; see
  [plaid-link.md](plaid-link.md). Real banks need `https`.

## Going live (real banks): a deliberate opt-in

Nothing in this repository links a real bank unless you do all of this on
purpose. It is never required for development or tests. Work through it in
order; `npm run preflight` (below) checks the parts it can.

> **Real data lives on the homelab server.** Go live there by following
> [homelab-deployment.md, "Going live with a real bank"](homelab-deployment.md#going-live-with-a-real-bank).
> Ruling (2026-11-23): the server's database already is the real-data database,
> so step 3 below is met there by deleting its one Sandbox connection's saved
> history before switching, and step 4 by keeping the server's own key, which only
> ever protected a Sandbox token. The steps below are for a copy on this computer.

1. **Know what your Plaid access allows.** On the Dashboard: Production (trial)
   access is enabled for Transactions; how many Items the trial gives you (Plaid's
   billing page says 10, and that **removing an Item does not free a slot**, so
   every real link counts, including ones you later disconnect); and, for the bank
   you want (for example PNC), that it shows as available on the OAuth institutions
   page. Most large US banks, PNC included, use OAuth.
2. **Get an https redirect address working.** OAuth banks need one, and Plaid
   allows plain `http://localhost` only in Sandbox. The simplest route is
   [local https](local-https.md): `https://localhost:3000/plaid/oauth`, registered
   in the Dashboard. Try it with a Sandbox link first (it validates the address with
   Plaid). Hosting somewhere else is only needed if you later want the app reachable
   from outside ([future-deployment.md](future-deployment.md)).
3. **Use a separate database for real data.** Do not mix it with Sandbox: use a
   separate Compose project (`docker compose -p home-finances-live ...`) or at
   least a separate database, so there is a separate volume and separate backups.
   Every query is already filtered by environment, and tokens are bound to their
   environment when encrypted, but separation is the real safeguard.
4. **Use a different `TOKEN_ENCRYPTION_KEY`** for the live environment, and back it
   up separately before linking anything.
5. Put production credentials in that environment's `.env`:

   ```text
   PLAID_ENV=production
   PLAID_CLIENT_ID=<production client id>
   PLAID_SECRET=<production secret>
   PLAID_LIVE_OPT_IN=yes
   APP_URL=https://localhost:3000
   PLAID_REDIRECT_URI=https://localhost:3000/plaid/oauth
   ```

   The app **refuses to start with `PLAID_ENV=production` unless
   `PLAID_LIVE_OPT_IN=yes` is also set**, so a stray edit or a copied `.env`
   cannot switch it. The Connections page then shows a prominent "Production:
   real bank data" notice.
6. **Run the checklist:** `docker compose exec app npm run preflight` (on the server: `ssh homelab home-finances/hf preflight`). It is
   read-only and contacts no one. It checks what it can see (https, a matching
   redirect address, Sandbox data kept apart, a restricted database role, a recent
   backup, an unfinished key rotation, how many trial Items you have used) and lists
   what only you can check (disk encryption, that secrets are not cloud-synced,
   that the key is backed up, the Dashboard settings). In Sandbox mode it shows
   what is still missing as warnings; in production a failure exits non-zero.
7. **Take a backup and test a restore** before the first real link.
8. **Link one bank, choosing every account you want the first time.** Later, add or
   drop accounts with *Add or change accounts* on the Connections page. Do **not**
   link the same bank again to do that: it uses another trial slot and, at PNC,
   invalidates the first connection (Plaid's OAuth page: a new link with the same
   credentials and different accounts invalidates the existing PNC Item).
9. PNC specifics from Plaid's docs: consent must be refreshed once a year
   (use *Reconnect*; there are no webhooks yet, so the app only notices when you
   refresh or sync).

The first real link is always your own explicit click; the app never does it for
you. Do not point an internet-reachable copy at real accounts until the items in
[future-deployment.md](future-deployment.md) are done.

## Importing the workbook

A one-time command brings the household's spreadsheet into the app: its
accounts, balances, pay, bills and the answers it needs from you. It runs once
per household and refuses a second time.

1. **Copy the file into `imports/`** in the repository folder (create the folder
   if needed). `imports/` is ignored by git and by the Docker build, and the
   importer reads nothing outside it and contacts nothing.
2. **Set the household's time zone** if Home still asks for it.
3. **Dry run** (writes nothing):

   ```bash
   docker compose exec app npm run import:workbook -- imports/Home_Finances_Simplified_v2.xlsx
   ```

   It prints every account, balance, rule (for review) and per-date edit it would
   create, checks its rules against the Bill Schedule and its forecast against the
   Cash Flow sheet, and lists notes, **questions** and **problems**.
4. **Answer the questions** in `imports/choices.json` (also ignored; the command reads
   it by default, and `--choices imports/<file>.json` names another file in
   `imports/`) and run the dry run again until it lists no questions and no problems:

   ```json
   {
     "cards": { "<bill id>": "<card Account ID>" },
     "pays": { "<bill id>": "<card Account ID, or null>" },
     "schedule": { "<Bill Schedule ID>": "skip | confirm | rule" }
   }
   ```

   `cards` says which card each bill "Included in card payment" is charged to;
   `pays` which card a card-payment bill pays (a label only); `schedule` what to do
   with a schedule row whose amount differs from its bill (`skip` that occurrence,
   `confirm` the schedule's amount, or keep the `rule`'s). Fix problems in the
   workbook or in `choices.json`. When there is more than one household, add
   `--household <id>` to every run to say which one to import into.
5. **Back up** (on the host): `npm run backup`.
6. **Apply:** the same command with `--apply`. It shows the same printout, asks you
   to type `yes`, and writes everything in one transaction (or nothing).
7. Review every imported rule on **Bills & income**, and the forecast on **Home**.
   Then delete the files in `imports/` if you no longer need them there.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "Unknown field … for omit statement" after an update | The running dev server has the old database client: `docker compose restart app` |
| Sign-in says it is not allowed from this origin, or hot reload fails | You opened `127.0.0.1`; use <http://localhost:3000> |
| Plaid values in `.env` are ignored | `docker compose up -d --force-recreate app` |
| "Too many sign-in attempts" | 5 attempts a minute are allowed, shared by everyone; wait a minute |
| A bank shows "Sign-in needed" | Connections → *Reconnect* |
| Sync says "No transactions yet" | Normal right after linking; Plaid is still preparing them. Try again in a few minutes |
| Port 3000 already in use | Set `APP_PORT=3001` in `.env`, set `APP_URL=http://localhost:3001` to match, and `docker compose up -d --force-recreate app`. The database is not published to the host at all |
| `docker` commands fail | Start Docker Desktop and wait for it to say it is running |
