# Home Finances

A local-first, single-household finance app: sign in, link a Plaid **Sandbox**
institution, and see account balances. Built with Next.js (App Router),
TypeScript, PostgreSQL, Prisma and the Plaid Node SDK.

Design and scope live in [docs/home-finances-spec.md](docs/home-finances-spec.md);
the build plan is [docs/local-docker-implementation-plan.md](docs/local-docker-implementation-plan.md).
This repository currently covers **Task 1: the containerized dev environment**.
Nothing here deploys anything or contacts a bank.

## Prerequisites

- Docker Desktop, running, with Linux containers (`docker version` should print a Server section)
- Node.js 24 LTS and npm (only needed on the host to run the setup script and, optionally, `npm run dev`)

## Quick start (PowerShell or any shell)

```bash
npm run setup:env
docker compose up --build
```

Then open <http://localhost:3000>. The app is published on `127.0.0.1` only.

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
docker compose exec app npm run test:integration   # no tests yet (Task 2)
docker compose exec app npm run build
docker compose logs -f app
```

`npm run test:e2e` intentionally fails for now: browser tests (Playwright) arrive
with authentication in Task 3, and an unexecuted browser test is not a pass.

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

## Layout

```text
compose.yaml / compose.debug.yaml   local services (debug override is opt-in)
Dockerfile                          dev and production targets
scripts/setup-env.mjs               generates .env with random local secrets
src/app/                            App Router pages and route handlers
src/lib/config.ts                   validated server configuration (server-only)
tests/                              Vitest tests
```

## Not yet covered

Database schema, token encryption, authentication, Plaid, sync, backups and
future deployment prerequisites arrive in Tasks 2–7 of the plan. Do not deploy
this app or point it at real bank accounts until then.
