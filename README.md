# Home Finances

A local-first, single-household finance app: sign in, link a Plaid **Sandbox**
institution, and see account balances. Built with Next.js (App Router),
TypeScript, PostgreSQL, Prisma and the Plaid Node SDK.

Design and scope live in [docs/home-finances-spec.md](docs/home-finances-spec.md);
the build plan is [docs/local-docker-implementation-plan.md](docs/local-docker-implementation-plan.md).
This repository currently covers **Task 1** (containerized dev environment),
**Task 2** (database schema and encrypted token storage), **Task 3** (closed
household authentication), **Task 4** (connecting a Plaid Sandbox bank and viewing
balances), **Task 5** (reconnect, disconnect, OAuth support), **Task 6** (manual
transaction sync) and **Task 7** (backup and restore, key rotation, security
verification, handoff documentation). Nothing here deploys anything or contacts a
real bank.

You can also add accounts by hand (Accounts → **Add an account**) and record their
balances on one date (**Update balances**). Hand-entered balances are real financial
data that exists nowhere else, so run `npm run backup` regularly from now on.

**Attaching a bank.** Once a bank is connected, each of its accounts can be
attached to the hand-entered account it really is (Connections → *Use for…*). The
account keeps its name, bills, income and typed balances, and from then on gets
its balances and transactions from the bank. Deleting the bank's saved history
later gives it back to hand entry instead of deleting it. See
[docs/plaid-link.md](docs/plaid-link.md#attaching-a-bank-account-to-one-entered-by-hand).

**Bills and income.** Each bill or income stream is a rule that produces dates
(every N weeks, every N months on a day, twice a month, or once; a day past the
month's end means its last day). Occurrences are computed, never stored, so
nothing needs regenerating. "Change from…" ends the current version and starts
an edited copy; "Stop on…" sets an end date; per-date edits are kept across
versions. Income can be split across accounts, with one account taking the rest.

**Forecast.** Home projects every cash account's end-of-day balance for the
next 90 days, starting from its latest balance (a hand-entered balance is true
at the end of its date; a bank balance is dated by the day it was observed).
Occurrences after that date count, Paid ones included; Skipped ones never do.
Bills paid from a card move no cash. Home also lists what needs attention: days
below the cushion or below zero, estimates due in the next 14 days, stale or
missing balances, "Did it clear?" for open items on a balance's date or in the
45 days before it, and per-date edits a rule no longer produces. The forecast is a pure
function and nothing it computes is stored.

**Register, Calendar and the occurrence panel.** The Register lists one cash
account's items with the balance after each, and the Calendar shows a month of
them with each day's end-of-day balance; both come from the same forecast as
Home, so the numbers always agree. Estimates are in italics; days below the
cushion or below zero are tinted. Clicking any item opens its panel: mark it
Confirmed (with the amount), Paid or Skipped, move this one date, or add a note,
and see what that does to the account's lowest point before saving. Reset to rule
deletes the edit. "Did it clear?" questions are answered on Home and right after
Update balances: Cleared marks the item paid; Still pending moves it to the day
after the balance.

**Workbook import.** `npm run import:workbook -- imports/<file>.xlsx` (in the app
container) brings the household's spreadsheet in once: accounts, balances, pay,
bills and per-date edits. It is a dry run unless given `--apply`, prints every
rule for review, checks its result against the workbook's own Bill Schedule and
Cash Flow, and asks what it cannot work out (answers go in `imports/choices.json`).
`--apply` writes everything in one transaction and refuses while any question is
open or if the household was already imported. `imports/` is ignored by git and
by the Docker build. Steps: [docs/local-development.md](docs/local-development.md#importing-the-workbook).

| Read this | For |
| --- | --- |
| [docs/local-development.md](docs/local-development.md) | day-to-day operation: restarts, tests, **backups and restore**, **encryption-key backup and rotation**, Sandbox testing, **going live**, troubleshooting |
| [docs/auth.md](docs/auth.md) | sign-in, sessions, CSRF, throttling |
| [docs/plaid-link.md](docs/plaid-link.md) | connecting, reconnecting, disconnecting and deleting data; OAuth and its **https** redirect requirement |
| [docs/transaction-sync.md](docs/transaction-sync.md) | how a sync stays all-or-nothing, and how to inspect it |
| [docs/local-https.md](docs/local-https.md) | serving the app over https on your own computer (required for real OAuth banks) |
| [docs/future-deployment.md](docs/future-deployment.md) | what must be true **before** this is ever hosted (nothing has been deployed or approved) |
| [docs/homelab-deployment.md](docs/homelab-deployment.md) | **running it on the homelab server**: first-time setup, `npm run deploy`, rollback, encrypted backups and restore |

## Prerequisites

- Docker Desktop, running, with Linux containers (`docker version` should print a Server section)
- Node.js 24 LTS and npm (only needed on the host to run the setup script and, optionally, `npm run dev`)

## Quick start (PowerShell or any shell)

```bash
npm run setup:env
docker compose up --build -d
docker compose exec app npm run db:migrate
docker compose exec app npm run auth:bootstrap
```

`auth:bootstrap` asks for your name, email and a password (typed hidden, 12+
characters) and creates the household and its first member. Registration through
the website is closed; this command is the only way accounts are created.

Then open <http://localhost:3000> and sign in. The port is published on the loopback interface only. Always browse to `localhost`, not `127.0.0.1`: `APP_URL` is `http://localhost:3000`, the sign-in Origin check compares against it exactly, and the Next.js dev server blocks hot-reload (HMR) for other hostnames.
(`db:migrate` creates the tables and the restricted database role. It is safe to
re-run and is only needed on first setup and after pulling new migrations.)
Drop the `-d` to watch the logs in the foreground instead.

`npm run setup:env` copies `.env.example` to `.env` and fills in fresh random
secrets. It refuses to overwrite an existing `.env`. **Back up
`TOKEN_ENCRYPTION_KEY` somewhere safe and separate from any database dump**:
once tokens are stored, they are unreadable without it.

Stop with `docker compose down`. That keeps your data. `docker compose down -v`
deletes the database volume and everything in it, so do not use it as routine cleanup.

## Everyday commands

Run these inside the app container so they use the Linux toolchain:

```bash
docker compose exec app npm run lint
docker compose exec app npm run typecheck
docker compose exec app npm test
docker compose exec app npm run test:integration   # needs the db service; uses a throwaway database
docker compose exec app npm run build
docker compose exec app npm run db:migrate         # apply migrations + refresh app-role grants
docker compose exec app npm run db:migrate:dev -- --name describe_the_change   # create a NEW migration
docker compose exec app npm run auth:bootstrap -- --add-member   # add another person to the household
docker compose exec app npm run sync                 # list connections; `-- <id>` or `-- --all` to sync transactions
docker compose exec app npm run keys:rotate           # re-encrypt tokens after a key change (dry run unless --apply)
docker compose exec app npm run preflight             # read-only checklist for linking a real bank
docker compose logs -f app
```

Backups and checks that drive Docker run **on the host** (plain Node, so they work
from PowerShell):

```bash
npm run backup                    # verified dump into ./backups (git-ignored, not encrypted)
npm run restore -- <dump file>    # restores into a NEW separate database; never the live one by default
npm run test:backup               # backup -> restore round trip on throwaway databases
npm run verify:image              # build the production image, scan it for secrets, run the browser suite against it
```

Browser tests (Playwright) run **on the host** against the running stack:

```bash
npx playwright install chromium   # once; downloads a browser (~120 MB)
npm run test:e2e                  # needs `docker compose up` running
```

They create a labelled throwaway user in the development database and delete it
afterwards; see [docs/auth.md](docs/auth.md).

Build the production image locally (the server builds its own; see docs/homelab-deployment.md):

```bash
docker build --target production -t home-finances:local .
```

### Where things live

| Thing | Where it persists |
| --- | --- |
| Database | named volume `home-finances_db-data` (survives `down`/`up`) |
| Linux `node_modules` | named volume `home-finances_app-node-modules` |
| Next.js build cache | named volume `home-finances_app-next` |
| Secrets | `.env` (git-ignored) |

If you change `package.json`, rebuild and refresh the dependency volume:

```bash
docker compose down
docker volume rm home-finances_app-node-modules
docker compose up --build
```

## Faster Next.js loop (optional)

Docker Desktop on Windows delivers file-change events slowly, so the Compose app
uses webpack with polling; edits appear after a few seconds. The Next.js docs
recommend running `next dev` directly on the host for development. To do that,
start only the database with its optional localhost-only port and point
`DATABASE_URL` at it:

```bash
docker compose -f compose.yaml -f compose.debug.yaml up db
npm install
npm run dev
```

The debug override publishes PostgreSQL on `127.0.0.1:5433` (not 5432, which a
native Windows PostgreSQL commonly occupies). It is never part of normal startup.
In a host-run `.env`, use `127.0.0.1:5433` in place of `db:5432` in `DATABASE_URL`.

## Choices made in Task 1

- **Next.js 16.4.3, React 19.3, Node 24 LTS, PostgreSQL 17.** Versions are pinned by `package-lock.json` and the Dockerfile.
- **Cache Components enabled** (the Next.js 16 scaffold default). Pages are dynamic unless a component or function opts into caching with `use cache`. `GET /api/health` calls `connection()` so it is evaluated per request instead of being frozen at build time. Household data must never be cached in shared caches.
- **Config is validated at runtime** by `src/lib/config.ts`. Error messages name the variable, never its value. Plaid credentials are optional for now (a half-set pair is an error); the connections page shows a notice and hides the Connect button until they are set.
- **Plaid environments** are `sandbox` and `production` only. There is no legacy `development` option.
- **zod** validates configuration; **Vitest** runs tests.

## Choices made in Task 2

- **Prisma 7.10.1**, with `@prisma/adapter-pg`, all pinned exactly. The `prisma` CLI's npm `latest` tag currently points at an 8.0 release candidate, so the CLI is pinned to the stable 7.10.1 to match `@prisma/client`; ignore the "update available" banner until 8.x is stable. The generated client lives in `src/generated/prisma` (git-ignored; `npm run db:generate` rebuilds it, and `build`, `typecheck` and `test:integration` do so automatically).
- **Migrations are explicit.** Nothing migrates on app startup. Create a migration with `db:migrate:dev`, commit the folder under `prisma/migrations/`, and apply committed migrations with `db:migrate`. `prisma migrate reset` is never needed for routine work and deletes data.
- **Two database roles.**
  - `POSTGRES_USER` (the *owner*) runs migrations. In the official image it is a PostgreSQL superuser, so the running app does not use it.
  - `APP_DB_USER` (`home_finances_app`) is what `DATABASE_URL` connects as: read/write rows only. It cannot create or alter tables, create databases or roles, truncate, or read migration history (all covered by integration tests). `db:migrate` creates it and re-applies its grants after every migration.
  - Dev concession: the dev container receives *both* URLs (via `env_file`) so it can run migrations. Application code only ever reads `DATABASE_URL`. A production setup would run migrations from a separate job holding the owner credential and give the app container only `DATABASE_URL`.
- **Money and nulls.** Amounts are `Decimal(19,4)`; nullable balances mean "not reported", never zero. A transaction's account must belong to the same Item (composite foreign key), so cross-connection rows are rejected by the database itself.
- **Sessions and users.** Task 3 reshaped `User` and `Session` for Better Auth and added `AuthAccount`, `Verification` and `RateLimit` (migrations `better_auth_tables` and `verification_table`); see docs/auth.md.
- **Integration tests never touch your data.** Each run creates a uniquely named `hf_test_*` database, applies the committed migrations, and drops it afterwards. They must run inside the app container (`MIGRATION_DATABASE_URL` points at the `db` service).
- **Standalone scripts are `.mts`** (ESM) because the project is CommonJS by default; `tsx` cannot use top-level `await` in a plain `.ts` file there.

### Token encryption and the encryption key

Plaid access tokens are encrypted before storage with AES-256-GCM (`src/lib/crypto/tokens.ts`). Stored values look like `v1.<keyId>.<nonce>.<ciphertext>.<tag>`. The Item's environment and Plaid Item ID are bound in as authenticated context, so a token copied to another row, or a sandbox token presented as a production one, fails to decrypt. Other code must call `encryptToken` / `decryptToken` and never use crypto primitives directly.

- **Back up `TOKEN_ENCRYPTION_KEY`** (from `.env`) separately from database dumps, in restricted storage. Without it stored tokens are unrecoverable, and with it plus a dump they are readable.
- **Rotation** is supported end to end since Task 7: put the new key in `TOKEN_ENCRYPTION_KEY`, the old one in `TOKEN_ENCRYPTION_RETIRED_KEYS`, and run `npm run keys:rotate -- --apply`. **Do not just replace the key**: tokens stored under the old one become unreadable and each bank would have to be reconnected. The steps are in [docs/local-development.md](docs/local-development.md#rotating-the-token-encryption-key).

### Existing `.env` from Task 1

`npm run setup:env` refuses to overwrite `.env`. If yours predates Task 2 it lacks `APP_DB_USER`, `APP_DB_PASSWORD` and `MIGRATION_DATABASE_URL`. Add them (compare with `.env.example`: `MIGRATION_DATABASE_URL` is your old `DATABASE_URL`, and the new `DATABASE_URL` uses the app role), then `docker compose up -d app` to reload them and `docker compose exec app npm run db:migrate`.

## Choices made in Task 3

Authentication uses **Better Auth** with **Argon2id** password hashing, closed
registration and a CLI bootstrap. The rationale, trade-offs, cookie settings,
throttling behaviour and the rule "authorize in every page, action and route,
using the household from the session" are in [docs/auth.md](docs/auth.md).
Highlights:

- `requireHousehold()` returns `{ userId, householdId }` from the server-side session; the browser never supplies a household id.
- Custom mutation routes begin with `authorizeMutation(request)` (Origin check, then session).
- Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` on https. Plain `http` is accepted only for `localhost`.
- Sign-in is limited to 5 attempts a minute, shared by all callers (the app does not trust `X-Forwarded-For`).
- `APP_URL` must match the address you browse to, because the Origin check compares against it.

## Choices made in Task 4

The Plaid flow, what is stored, the protections and the recovery steps are in
[docs/plaid-link.md](docs/plaid-link.md). Highlights:

- **plaid 49.0.0** (official Node SDK) and **react-plaid-link 5.0.0**, both pinned. All SDK access is in `src/features/plaid/client.ts`, which reduces SDK errors (they embed the request, including secrets) to a category plus Plaid's error code and request id.
- Link is requested for **Transactions only, 365 days** (90 for connections made before 2026-11-25). Balances come from `/accounts/get` and are shown with the time they were observed. Nothing calls Plaid when a page is viewed; fetching is an explicit click.
- A public token is exchanged **once**: the attempt is claimed atomically, and any uncertain outcome becomes `NEEDS_RECONCILIATION` instead of a retry.
- Browser tests never call Plaid's API or any bank (the pages that include Plaid Link do load Plaid's Link script from Plaid's servers, as any browser would). The real Link flow is a manual Sandbox check; see the end of docs/plaid-link.md.
- Dev dependency refresh: after pulling this change, rebuild the dependency volume (see "Where things live") and run `docker compose exec app npm run db:migrate`.

## Choices made in Task 5

Details and recovery steps are in [docs/plaid-link.md](docs/plaid-link.md).

- **Reconnect** uses Plaid's update mode on the existing connection (no token exchange, since the access token does not change). **Disconnect** calls `/item/remove`, erases the stored token and keeps your saved history; **Delete saved history** is a separate typed confirmation, allowed only for a disconnected bank.
- If Plaid cannot confirm a removal (it no longer knows the Item, or the stored key was lost), the bank is disconnected here but flagged so you check the Plaid Dashboard; a network failure leaves everything unchanged so you can retry.
- **OAuth support** is built (redirect page `/plaid/oauth`, original link token kept encrypted until the attempt ends). `PLAID_REDIRECT_URI` stays blank unless you want it: it must be registered in the Plaid Dashboard and be https, except `http://localhost` in Sandbox. A real round trip through a bank was **not** tried (Sandbox desktop browsers use a pop-up instead); see the end of docs/plaid-link.md.
- `npm run plaid:sandbox` is a Sandbox-only helper to force "sign-in needed" for trying Reconnect.
- After pulling this change run `docker compose exec app npm run db:migrate`.

## Choices made in Task 6

Full design, guarantees and recovery steps are in [docs/transaction-sync.md](docs/transaction-sync.md).

- **Manual only.** Transactions are fetched when you press **Sync now** (Transactions page, at most once a minute per bank) or run `npm run sync`. Both call the same service. Opening a page never contacts Plaid.
- **All or nothing.** A sync reads every page into memory, then commits in one database transaction that first proves nothing changed (lease token, cursor and cursor version). Any failure (timeout, bank outage, data changing mid-read, a lost lease, a database error) leaves the stored data and the cursor exactly as they were.
- **One at a time per bank**, using a database lease that expires by itself if a worker dies. Transient errors are retried a bounded number of times; "data changed while paging" restarts the whole batch from the original cursor.
- **No data yet is not an error.** Plaid answers with empty results and an empty cursor right after linking; that is recorded as a success and the empty cursor is never saved.
- **Amounts keep Plaid's sign** (positive = money out) as exact decimals; removed transactions are marked, not deleted; a posted transaction retires its pending twin so a charge is never counted twice.
- After pulling this change: `docker compose exec app npm run db:migrate`, then **restart the app container** (`docker compose restart app`) so the running dev server picks up the new database client.

## Choices made in Task 7

- **Backups** are verified `pg_dump` files written by tooling on the host (`npm run backup`). They are not encrypted, are git-ignored and excluded from the Docker build, and **never include the encryption key**. Sessions and sign-in counters are left out on purpose. See [docs/local-development.md](docs/local-development.md#backups).
- **Restore** defaults to a separate new database and refuses to touch the live one unless you pass `--replace-live --confirm <name>` with the app stopped. Even then it builds the replacement on the side and swaps by renaming, keeping the old database as a way back. A real restore of this project's own data exposed one bug (a link attempt that pointed at a session which is deliberately not backed up); it is fixed and has a test.
- **Key rotation** is wired up (`TOKEN_ENCRYPTION_RETIRED_KEYS`, `npm run keys:rotate`): dry run by default, compare-and-set per token, idempotent, and it reports counts and ids only.
- **Real banks are a deliberate opt-in.** `PLAID_ENV=production` is refused unless `PLAID_LIVE_OPT_IN=yes` is also set; use a separate database and key for real data ([going live](docs/local-development.md#going-live-real-banks-a-deliberate-opt-in)).
- **Security verification** is automated: source-tree rules (no client component imports a server-only module, every mutating route is guarded before it does any work, secrets are read from the environment in one file, nothing logs a whole error), cross-household and CSRF tests that discover every route themselves, cacheability and header checks, and a log-leak test. `npm run verify:image` also scans the production image for your secret values and runs the browser suite against it. Every one of these checks was shown to fail when the property it guards was deliberately broken.
- **Browser hardening headers** (`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`) are set; a Content-Security-Policy is deliberately not, until one is tested against Plaid Link.
- **Hosting**: the app runs on the household's homelab server, reachable only over Tailscale ([docs/homelab-deployment.md](docs/homelab-deployment.md)). The cloud-VM checklist in [docs/future-deployment.md](docs/future-deployment.md) still applies to any internet-facing hosting.

## Layout

```text
compose.yaml / compose.debug.yaml   local services (debug override is opt-in)
Dockerfile                          dev and production targets
prisma/schema.prisma                data model (see the comments in the file)
prisma/migrations/                  committed, versioned schema changes
prisma.config.ts                    Prisma CLI configuration
scripts/setup-env.mjs               generates .env with random local secrets
scripts/migrate.mts                 `npm run db:migrate`
scripts/lib/database.mts            migration runner and app-role setup (also used by tests)
src/app/                            App Router pages and route handlers
src/lib/config.ts                   validated server configuration (server-only)
src/lib/db.ts                       Prisma client factory and per-process singleton
src/lib/crypto/tokens.ts            authenticated token encryption (server-only)
src/features/plaid/                  Plaid gateway (SDK), link flow, account refresh, formatting
src/features/accounts/               hand-entered accounts and balances (service, input parsing, HTTP helpers); pages in src/app/accounts/
src/features/rules/                  bills and income: the date calculations, splits and change planning (pure, shared with the forms), the request bodies, and the server-only reads and writes; pages in src/app/bills/
src/app/register/, calendar/, occurrences/  the Register, the Calendar and the occurrence panel
src/features/forecast/               the forecast: latest balances, occurrences with edits, the daily series, Needs attention, the Register's rows, the Calendar's grid and an edit's effect (pure), and the server-only loaders and "Did it clear?" answers
src/features/import/                 the workbook import: reading the xlsx, the sheets, choices.json, the plan and its two checks (pure), and the server-only writer
src/components/                     Plaid Link button and refresh button (client components)
src/lib/auth/                       Better Auth config, requireHousehold, origin checks, password hashing
src/lib/data/                       household-scoped data access helpers
src/proxy.ts                        optimistic redirect for visitors with no session cookie
src/app/login/, src/app/api/auth/   login page and the Better Auth route handler
scripts/bootstrap-user.mts          `npm run auth:bootstrap` (hidden password prompt)
scripts/plaid-sandbox.mts           `npm run plaid:sandbox` (Sandbox-only reconnect helper)
scripts/sync.mts                    `npm run sync` (same sync service as the button)
scripts/rotate-token-key.mts        `npm run keys:rotate` (re-encrypt stored tokens under the current key)
scripts/backup.mjs, restore.mjs     `npm run backup` / `restore` (host-side; helpers in scripts/lib/backup.mjs)
scripts/verify-production-image.mjs `npm run verify:image`
scripts/preflight-live.mts          `npm run preflight`
scripts/import-workbook.mts         `npm run import:workbook` (dry run unless --apply)
compose.https.yaml, docker/caddy/   opt-in local https (a TLS proxy); see docs/local-https.md
docs/                               spec, plan, and the guides listed at the top of this file
playwright.config.ts, tests/e2e/    browser-test setup (*.e2e.spec.ts)
tests/                              Vitest unit tests; *.integration.test.ts use a real database
```

## Status and limits

All seven tasks of the plan are done. Be clear about what that does and does not mean:

- It runs **locally, on Plaid Sandbox**. Real banks are possible only through the deliberate opt-in above, and nothing has been tried against a real institution.
- It is hosted **privately** (Tailscale only). It is not ready for the open internet: there is no Content-Security-Policy yet, and the cloud-VM checklist in [docs/future-deployment.md](docs/future-deployment.md) has not been worked through.
- There are no webhooks and no scheduled syncs; transactions sync only when you ask.
- A real OAuth redirect round trip through a bank was not exercised (Sandbox in a desktop browser uses a pop-up instead).
- Backups are local and unencrypted; they protect against mistakes, not against losing the computer.
