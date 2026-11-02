# Local Docker and Plaid Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task by task if available. Use subagent-driven-development only when delegation is authorized. Track the checkboxes below. Read both this plan and the accompanying spec before editing code.

**Goal:** Run Home Finances locally with one Docker Compose command, sign in, and connect Sandbox accounts through Plaid; then add reliable manual transaction synchronization.

**Architecture:** One Next.js application owns the UI, authentication, authorization, Plaid integration, and database access. Compose runs the development app and PostgreSQL with persistent storage. Start locally; a later production image can run behind the existing VM's Nginx, subject to a separate deployment review.

**Tech stack:** Next.js App Router, TypeScript, supported Node LTS, PostgreSQL 17, Prisma, official Plaid Node SDK, maintained session/auth library, Vitest, and Playwright.

**Spec:** [home-finances-spec.md](home-finances-spec.md). This plan narrows its local runtime to a containerized app plus database. Cloud work is excluded.

## Global constraints

- Repository baseline: README.md and LICENSE only, main at initial commit 92fcfe1 when inspected November 1, 2026. Recheck before execution; preserve subsequent user changes.
- No infrastructure, SSH keys, DNS, Nginx, IAM, firewall, or cloud resources may be changed by this plan. No deployment or purchase.
- Bind local app to 127.0.0.1:3000 on the host; inside the app container listen on 0.0.0.0:3000. Do not publish a database port by default.
- Default to Plaid Sandbox. Real account linking, Production credentials, public tunnels, and chargeable product activation require deliberate user opt-in.
- Do not commit secrets, bank credentials, access tokens, real financial fixtures, database dumps, or local database files.
- Do not add budgeting, payments, spreadsheet imports, investments, public registration, or webhooks to this milestone.
- Resolve current supported framework/runtime/library versions from official docs at execution time, record choices in README, and commit the dependency lockfile. Do not assume historical SDK signatures.
- Authorization belongs in every server entry point and service boundary, not only a page redirect or middleware.
- Commit only scoped changes after relevant checks; never automatically push. Report actual verification results and any limitations.

## Intended file boundaries

```text
compose.yaml                         local development services and volume
Dockerfile                           development and production targets
.dockerignore                        exclude secrets, dumps, host dependencies
.env.example                         names and safe defaults, no usable secrets
package.json / package-lock.json     pinned tooling and portable commands
prisma/schema.prisma                 model constraints and database types
prisma/migrations/                   versioned schema changes
src/app/                            App Router pages, actions, API routes
src/lib/config.ts                    validated server configuration
src/lib/db.ts                        database client lifecycle
src/lib/auth/                        sessions, password hashing, authorization
src/lib/crypto/tokens.ts             versioned authenticated token encryption
src/features/plaid/client.ts         official SDK configuration
src/features/plaid/link.ts           attempts, exchange, reconnect, disconnect
src/features/plaid/accounts.ts       authoritative account and balance ingestion
src/features/plaid/sync.ts           transaction ingestion and cursor handling
src/features/plaid/types.ts          shared server-side contracts
src/components/plaid-link.tsx        browser Link UI only
scripts/                            bootstrap, sync, backup and restore commands
tests/                              unit, integration and browser checks
```

Keep browser imports separate from server-only modules. Do not expose generic database records directly as page/API response objects.

## Task 1: A working containerized development environment

**Files:** Dockerfile, compose.yaml, .dockerignore, .gitignore, .env.example, package.json, package-lock.json, tsconfig.json, next.config.ts, src/app/layout.tsx, src/app/page.tsx, src/lib/config.ts, src/app/api/health/route.ts, tests/config.test.ts, README.md.

**Interfaces:** `getServerConfig()` validates configuration and returns typed server settings; `GET /api/health` returns only an application readiness status, no credentials or database connection details.

- [ ] Recheck git status and local instructions. Confirm Docker Desktop is installed, running, and using Linux containers with `docker version` and `docker compose version`. If unavailable, report the exact prerequisite; do not install or change system settings silently.
- [ ] Scaffold Next.js with TypeScript, App Router, src directory and a minimal responsive stylesheet. Select compatible versions and lock dependencies. Configure `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, and `build` scripts.
- [ ] Write a config test that rejects missing DATABASE_URL, invalid PLAID_ENV, and a malformed encryption key without including their values in the error. Run it and confirm failure before implementing validation.
- [ ] Implement server-only configuration validation. Generate local secrets through an explicit setup script rather than shipping defaults. Keep actual secrets ignored.
- [ ] Add development and production Docker targets. Development uses hot reload; production uses a Linux-built Next.js standalone artifact and a non-root user. Copy no .env or database backup into image layers. Production artifacts are prepared only, never deployed here.
- [ ] Configure app source bind mount, container-owned node_modules and .next volumes to avoid Windows/Linux native dependency conflicts. Run development as a non-root user; make container-owned directories writable during image creation.
- [ ] Configure PostgreSQL 17, a named data volume, pg_isready health check, and app startup dependency on database health. Host exposes only 127.0.0.1:3000. Provide an optional explicit localhost-only database debugging override, excluded from normal startup.
- [ ] Document: copy .env.example, run local secret setup, `docker compose up --build`, and visit localhost. Distinguish container DATABASE_URL host `db` from optional host tooling URLs. Explain that Docker Desktop must be running.
- [ ] Verify `docker compose config --quiet`, start the stack, open the app, edit a page and observe hot reload, and confirm database port 5432 is not published. Stop normally with `docker compose down`; never use `down -v` as routine cleanup.
- [ ] Run config tests, lint, type checking and production build. Commit the working environment.

## Task 2: Persistent schema and safe token storage

**Files:** prisma/schema.prisma, prisma/migrations/*, src/lib/db.ts, src/lib/crypto/tokens.ts, tests/tokens.test.ts, tests/database.integration.test.ts, scripts/migrate.ts.

**Interfaces:** `encryptToken(token: string, context: string): string`; `decryptToken(ciphertext: string, context: string): string`. Context is the immutable environment and Plaid Item ID. Later tasks must use these functions rather than access crypto primitives directly.

- [ ] Define User, Household, Membership, sessions, PlaidItem, Account, BalanceSnapshot, Transaction, LinkAttempt and SyncRun as specified in the companion spec. Add unique constraints on Item/environment, Item/account ID and Item/transaction ID. Use decimal money, currency, nullable balances and explicit dates.
- [ ] Write integration tests that reject duplicate provider identifiers, allow separate Items at one institution, preserve null balances, and enforce foreign keys. Confirm failure against the empty schema.
- [ ] Generate and apply the first migration inside the app container using `docker compose exec app npx prisma migrate dev --name initial`. Make migration execution explicit rather than destructive application startup behavior.
- [ ] Write encryption tests: round trip succeeds; modified ciphertext, wrong context and wrong key fail; repeated plaintext yields different ciphertext. Implement AES-256-GCM with random nonces and a versioned encoding containing key ID and authentication tag. Keep the encryption key outside PostgreSQL.
- [ ] Verify application database role privileges are bounded to this database. Document separate migration privilege needs for future production.
- [ ] Create synthetic persisted data, restart the database container, and verify retention. Run integration and encryption checks. Commit schema and token storage.

## Task 3: Closed household authentication

**Files:** src/lib/auth/*, src/app/login/page.tsx, src/app/api/auth/*, scripts/bootstrap-user.ts, tests/auth.integration.test.ts, tests/auth.e2e.spec.ts.

**Interfaces:** `requireHousehold(): Promise<{userId: string; householdId: string}>` for request-bound server operations. CLI commands use a separate explicit household lookup and must never bypass web authorization by sharing an unauthenticated entry point.

- [ ] Choose a maintained Next.js-compatible authentication/session library after checking current official guidance. Record the choice and rationale; use its session primitives rather than hand-rolling cookies.
- [ ] Write failing tests for unauthenticated access, an expired session, logout, a second household attempting to read the first household's Item, and a cross-origin mutation. Require authorization before provider calls.
- [ ] Implement closed registration, explicit bootstrap command, Argon2id password hashing if using passwords, generic login failures and throttling. Bootstrap accepts a securely prompted password, not a committed password or command-line argument visible in process listings.
- [ ] Apply HttpOnly, SameSite, expiration/revocation and Secure-cookie production settings. Protect every custom mutation route using session authorization and origin/CSRF defenses. Document loopback-only development exceptions.
- [ ] Verify browser sign-in/out and direct unauthorized API requests; confirm cross-household tests pass. Commit authentication.

## Task 4: Sandbox Link, accounts and balances

**Files:** src/features/plaid/{client,types,link,accounts}.ts, src/components/plaid-link.tsx, src/app/api/plaid/link-token/route.ts, src/app/api/plaid/exchange/route.ts, src/app/connections/page.tsx, src/app/accounts/page.tsx, tests/link.integration.test.ts, tests/link.e2e.spec.ts.

**Interfaces:** `createLinkAttempt(householdId, sessionId)` returns `{attemptId, linkToken}`; `exchangeLinkAttempt(householdId, sessionId, attemptId, publicToken)` returns a sanitized `{connectionId, status}`. Define concrete TypeScript types in types.ts before downstream use; session identity comes from the auth library.

- [ ] Mock the official SDK and write failing tests for successful exchange, expired/cross-session/replayed attempts, invalid token, provider timeout, repeated account ingestion, and database failure after provider success.
- [ ] Create link tokens server-side using stable opaque client_user_id, an expiring session-bound attempt and only entitled products. Default to Transactions and 90-day requested history when available; do not add Auth to obtain ordinary balance observations.
- [ ] Initialize the official browser Link integration. Handle cancellation and token expiry. Exchange public_token only on the server; encrypt the returned access token immediately and never serialize it to the client.
- [ ] Fetch authoritative account data with /accounts/get; persist accounts and balance observations with decimal-safe conversions and currency. Mark unavailable accounts explicitly. Keep cached balances clearly timestamped.
- [ ] Prevent duplicate Item/account rows with database uniqueness, not only prechecks. Track uncertain exchange/persistence outcomes for reconciliation; do not blindly retry a consumed public token. Document recovery and orphan Item cleanup.
- [ ] Add connection and accounts screens with loading/error/retry states and masked identifiers. Do not log token-bearing SDK errors or callback payloads. Disable shared caching of household data.
- [ ] Run automated tests and a user-initiated Sandbox Link smoke test. Confirm client responses and rendered pages contain no access token. Commit milestone one: sign-in plus linked Sandbox accounts.

## Task 5: OAuth, reconnect and disconnect

**Files:** src/app/plaid/oauth/page.tsx, src/app/api/plaid/reconnect/route.ts, src/app/api/plaid/disconnect/route.ts, src/features/plaid/link.ts, tests/connection-lifecycle.integration.test.ts.

**Interfaces:** `createUpdateLinkAttempt(householdId, sessionId, connectionId)`; `disconnectItem(householdId, connectionId)`. Look up the Item by authorized household, not browser-supplied Plaid ID.

- [ ] Write tests for OAuth return bound to the original attempt, expired attempts, ITEM_LOGIN_REQUIRED, disconnect success, and failed provider removal preserving a retryable local state.
- [ ] Preserve the original short-lived link token for OAuth continuation; reinitialize Link with receivedRedirectUri and original token. Clear temporary state after success or expiry; do not log callback query strings.
- [ ] Implement update mode on the existing Item and a reconnection-required status. Implement /item/remove on explicit disconnect; erase token after confirmed removal. Explain retained history and require separate confirmation before deleting local history.
- [ ] Verify Sandbox OAuth continuation and expired/cancelled flows. Document that real-bank OAuth generally needs a registered HTTPS redirect; do not open a public tunnel as part of implementation.
- [ ] Document Sandbox versus Production/Trial and explicit live opt-in. No automated test may call real institutions. Commit connection lifecycle support.

## Task 6: Reliable manual transaction synchronization

**Files:** src/features/plaid/sync.ts, scripts/sync.ts, src/app/api/plaid/sync/route.ts, src/app/transactions/page.tsx, tests/sync.integration.test.ts.

**Interfaces:** `syncItem(householdId: string, connectionId: string): Promise<SyncSummary>`; define SyncSummary with run ID, status, added/modified/removed counts, and completion time. Web route and CLI call this service. Cursor and tokens remain private.

- [ ] Write failing fixture-based integration cases for empty initial results, multiple pages, added/modified/removed data, mutation-during-pagination, pending-to-posted changes, concurrent sync and database rollback.
- [ ] Serialize sync per Item using a database-backed lease with expiry and ownership checks; a crashed worker must not permanently block the Item. Reject a stale lease holder's commit using a lease token/version and cursor check.
- [ ] Fetch /transactions/sync pages outside a long transaction into bounded staging. Keep the starting cursor unchanged until all pages succeed. On pagination mutation, discard the batch and restart from that starting cursor with bounded retries.
- [ ] In one database transaction, verify lock/cursor ownership, apply idempotent upserts/removals and pending relationships, and advance cursor. Failures leave committed data and cursor consistent. Keep provider signs and currency; avoid duplicate pending/posted spending.
- [ ] Provide throttled manual sync UI and explicit CLI execution. Page views read PostgreSQL and do not trigger paid fresh-balance calls. Distinguish no-data-yet, transient provider failure and reconnect-required errors.
- [ ] Run the full sync integration suite and a synthetic delayed-initial-data scenario. Verify a repeated sync is harmless. Commit milestone two.

## Task 7: Reproducible handoff and local recovery

**Files:** README.md, scripts/backup.*, scripts/restore.*, docs/local-development.md, docs/future-deployment.md, tests/security.integration.test.ts, optional CI configuration for synthetic tests.

- [ ] Provide Windows-friendly container commands for setup, migrations, bootstrap, tests, manual sync and log inspection. Document how to rebuild dependencies and what persists between restarts.
- [ ] Provide explicit local backup/restore procedures using pg_dump/pg_restore from PostgreSQL tools in containers. Keep dumps outside git and container image contexts; restore defaults to a separate test database and refuses to overwrite the active database without explicit confirmation. Local dumps are sensitive; label that these are not encrypted off-VM production backups.
- [ ] Back up synthetic data, restore into a separate database, and compare record counts and decimal values. Document separately backing up the token-encryption key; do not bundle it with database dumps.
- [ ] Verify server-only secrets, cross-household denial, safe error logging, CSRF, replay protection, and no sensitive shared caching. Run lint, typecheck, unit/integration/browser tests and a Linux production image build. Document any checks that could not run.
- [ ] Document future VM prerequisites: guest resource/Nginx inspection, TLS hostname, narrow bindings, SSH/RDP review, isolated service identity, encrypted off-VM backups with tested restoration, alerts and capacity checks. Explicitly preserve the prohibition on deployment without approval.
- [ ] Verify a fresh checkout can follow the documented setup and recover persisted synthetic data after normal restart. Commit the handoff documentation and report commands/results without claiming cloud readiness.

## Verification command contract

Create the package scripts referenced below in Task 1; adjust implementation details behind these scripts rather than forcing later agents to discover replacement commands.

```sh
docker compose config --quiet
docker compose up --build -d
docker compose exec app npm run lint
docker compose exec app npm run typecheck
docker compose exec app npm test
docker compose exec app npm run test:integration
docker compose exec app npm run test:e2e
docker compose exec app npm run build
docker build --target production -t home-finances:local .
docker compose down
```

Run integration/browser tests against synthetic databases with automatic test-data isolation, never a live-finance database. Make browser test dependencies available through a dedicated test image/service or a documented supported local runner. If that requires a separate command, update this contract and README together. Do not treat an unexecuted browser test as passing.

## Completion report expected from the implementing agent

List delivered milestones, setup commands, verification actually run, any failing or skipped checks, and the next user action for a Sandbox smoke test. Do not request real banking credentials in chat. Do not enable Production, upload secrets, deploy, or repair cloud access as a side effect of finishing the plan.

