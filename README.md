# Home Finances

A local-first, single-household finance app: sign in, link a Plaid **Sandbox**
institution, and see account balances. Built with Next.js (App Router),
TypeScript, PostgreSQL, Prisma and the Plaid Node SDK.

Design and scope live in [docs/home-finances-spec.md](docs/home-finances-spec.md);
the build plan is [docs/local-docker-implementation-plan.md](docs/local-docker-implementation-plan.md).
This repository currently covers **Task 1 (containerized dev environment)**,
**Task 2 (database schema and encrypted token storage)** and **Task 3 (closed
household authentication)**.
Nothing here deploys anything or contacts a bank.

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

Then open <http://localhost:3000> and sign in. The app is published on `127.0.0.1` only.
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
docker compose logs -f app
```

Browser tests (Playwright) run **on the host** against the running stack:

```bash
npx playwright install chromium   # once; downloads a browser (~120 MB)
npm run test:e2e                  # needs `docker compose up` running
```

They create a labelled throwaway user in the development database and delete it
afterwards; see [docs/auth.md](docs/auth.md).

Build the production image (prepared locally only, never deployed):

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
- **Config is validated at runtime** by `src/lib/config.ts`. Error messages name the variable, never its value. Plaid credentials are optional for now (a half-set pair is an error) and become required in Task 4.
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
- **Rotation** is supported by the cipher (a new key encrypts; retired keys still decrypt old data) but not yet wired into configuration or tooling. Until a re-encryption script exists, changing `TOKEN_ENCRYPTION_KEY` makes existing stored tokens undecryptable, and the fix would be to relink the affected connections. This will be completed with the backup/restore work in Task 7.

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
src/lib/auth/                       Better Auth config, requireHousehold, origin checks, password hashing
src/lib/data/                       household-scoped data access helpers
src/proxy.ts                        optimistic redirect for visitors with no session cookie
src/app/login/, src/app/api/auth/   login page and the Better Auth route handler
scripts/bootstrap-user.mts          `npm run auth:bootstrap` (hidden password prompt)
playwright.config.ts, tests/e2e/    browser-test setup (*.e2e.spec.ts)
tests/                              Vitest unit tests; *.integration.test.ts use a real database
```

## Not yet covered

Plaid linking, sync, backups and future deployment prerequisites
arrive in Tasks 4–7 of the plan. Do not deploy this app or point it at real bank
accounts until then.
