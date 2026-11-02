# Home Finances: inspection and Claude Code handoff

Prepared November 1, 2026. Scope: read-only repository and cloud inspection; proposed implementation only. No infrastructure, cloud credentials, SSH metadata, application code, or repository files were changed.

## Decision

Build locally with Next.js App Router, TypeScript, PostgreSQL, Prisma, and the official Plaid Node SDK. Use one application for UI and server logic. Hosting it alongside PostgreSQL on the existing VM is technically plausible for household traffic, but is conditional rather than deployment-ready: guest access failed, capacity is unmeasured, and backup and access controls need attention before real financial data is hosted.

Alternatives: a separate small VM improves isolation from demo sites but adds cost and maintenance; managed app/database hosting reduces server maintenance but adds services and cost. Start locally and retain a portable deployment artifact. No hosting purchase or resize is needed to begin.

## Verified repository facts

- Location: C:/Users/Drake/home-finances.
- Remote: https://github.com/Doogan1/home-finances.git.
- main tracks origin/main; working tree was clean.
- Only README.md (project title) and LICENSE are present. Latest commit: 92fcfe1, Initial commit.
- No application, dependencies, framework conventions, migrations, deployment files, AGENTS.md, or existing graphify graph were found in this repository. There is no Django implementation to migrate.

## Verified Google Cloud facts

Read using the authenticated local gcloud account Drake.Olejniczak@mallard-digital.com. Every cloud command explicitly selected mallard-digital-demo-sites; the active project and ADC quota configuration were not changed.

- VM: mallard-digital-vm, RUNNING, us-central1-a.
- Machine: e2-small, 2 visible shared-core vCPUs, 2048 MB RAM. Shared-core capacity is not equivalent to two dedicated cores.
- Boot image: Ubuntu 24.04 LTS, ubuntu-2404-noble-amd64-v20260517. This establishes the provisioned image, not the guest's current patch level or kernel.
- Disk: one 20 GB zonal pd-ssd persistent boot disk. It survives ordinary stop/start, but autoDelete=true deletes it when the VM is deleted. Deletion protection is false.
- Network: default VPC; internal IP 10.128.0.2; external IP 136.119.48.246. The external IP is reserved as mallard-digital-ip.
- Effective ingress rules: TCP 80 and 443 from anywhere via HTTP/HTTPS tags; TCP 22 and 3389 and ICMP from anywhere; all TCP/UDP and ICMP from 10.128.0.0/9. These describe network permission, not proof that a service is listening. No public 3000/5432 allow rule appeared in the returned effective policy.
- No Compute Engine snapshots or resource policies were listed. The disk has no listed snapshot schedule. No Cloud Storage buckets were listed in this project. This does not rule out guest jobs, backups in another project/provider, machine images, or other backup products.
- Automatic restart is enabled; the VM is not preemptible. Neither provides backup or high availability.

## Guest inspection limitation

Direct SSH as the username in existing instance metadata, using the existing google_compute_engine and mallard_key identities with BatchMode and strict known-host checking, returned Permission denied (publickey). Existing metadata includes expired Google SSH entries; that is a possible explanation, not a confirmed cause. No keys were generated or uploaded and no access settings were changed.

Consequently these remain unverified: running OS and patch status, actual free RAM/CPU/disk, swap, Nginx version and active server blocks, domain names, TLS/certificate renewal, upstream ports, enabled services, host firewall, SSH hardening, Docker/PostgreSQL presence, database volumes, guest backup scripts, restore history, and monitoring.

A later approved access repair or an already working SSH identity is needed to finish those checks. Do not silently use gcloud compute ssh if it would upload keys. Once access is available, inspect /etc/os-release, free, df, uptime, nginx -T, listening sockets, host firewall, services, timers, and backup job definitions. Read config carefully without copying secrets. Check certificate expiry/renewal and existing site routing. Review available memory and CPU under existing load over time rather than relying on one idle sample.

## Hosting requirements before deployment

The 2 GB VM may run one modest production Next.js process and a conservatively configured PostgreSQL instance alongside light sites. Existing workload could make it unsuitable. Build Linux-compatible artifacts off the VM; Next.js builds can cause memory contention here. Measure runtime usage, keep database connections small, bound logs, and set memory/disk alerts. If headroom is inadequate, propose a resize or separate VM with cost and downtime estimates for approval.

Use a dedicated finance hostname and TLS, with Nginx forwarding to a loopback-only app port. Keep PostgreSQL on loopback or a private container network without a published database port. A dedicated service user, restricted secret file, and supervised restart are sufficient; either systemd plus host PostgreSQL or Compose is viable. Preserve existing server blocks. Use appropriate proxy headers, authenticated no-store responses, and streaming-compatible buffering settings where needed. Never use next dev in production.

Before storing real data: review restricting public SSH, remove unnecessary RDP exposure after checking dependencies, and account for broad internal VPC access. Bind services narrowly even with cloud firewall controls. Review service-account IAM separately; its permissions were not audited here. Require application login, closed registration, household authorization, secure sessions, rate limiting, and CSRF defenses. Isolate financial secrets and files from other demo-site processes; a shared VM still shares its compromise/failure boundary.

Prefer a separately managed data disk with deletion retention for a future database; this requires approval. A persistent volume is not a backup. Propose encrypted off-VM pg_dump backups daily, seven daily and four weekly copies, plus tested restoration into a separate database. Initial recovery targets: at most 24 hours of data loss and same-day restoration, subject to an actual restore test. Back up encryption keys separately under restricted access, document key rotation, and alert on backup failure. Snapshots may supplement logical backups but do not replace restore verification. No backup automation has been installed.

## Copy-ready Claude Code implementation spec

### Objective and constraints

Implement a local-first, single-household finance app in the existing home-finances repository. First success: sign in, link a Sandbox institution through Plaid Link, persist the connection and accounts securely, and display balances with timestamps. Then add manual transaction sync. Support later opt-in real account linking through the user's Plaid Trial/Production permissions. Do not deploy, modify GCP/Nginx/firewall/IAM/DNS, add SSH keys, buy services, or contact real banks automatically.

Keep budgeting, paycheck allocations, spreadsheet import, investments, liabilities, transfers/payments, multi-household signup, and automatic categorization outside this milestone. Do not infer workbook requirements from missing attachments.

### Stack and local operation

Use a supported stable Next.js App Router release with TypeScript and a compatible supported Node LTS; verify current official requirements when implementing, pin versions, and commit a lockfile. Use PostgreSQL 17 with Prisma migrations and the official Plaid Node SDK. Use Node runtime for database/Plaid/crypto operations. Use Server Components for account views and a small Client Component for Link. Keep Plaid, database, encryption, and authorization modules server-only. Route handlers or Server Actions call shared domain services; do not add a separate Express or Django server.

Run Next.js locally on loopback. Provide Docker Compose for local PostgreSQL, a named persistent volume and health check, with any host database port bound to 127.0.0.1. Normal restart must retain data; document that deleting the volume is destructive. Include a credential-free .env.example, ignored local secret files, setup/migration/seed/test/build commands, and Windows-friendly instructions. Docker Desktop availability must be checked rather than assumed. Never commit real credentials or financial fixtures.

### Identity and authorization

Use a maintained authentication library compatible with the selected Next.js version. Implement closed registration and an explicit local bootstrap command for the first household member; no default password. Password login, if selected, uses a vetted Argon2id implementation, generic errors, throttling, and library-managed sessions. A second member is added explicitly to the same household. All page loaders, actions, and API operations must independently authorize household membership; a route guard alone is insufficient. HttpOnly, SameSite cookies; Secure outside loopback development; expiry, logout, and session revocation. Apply origin/CSRF protection to mutations, including custom exchange routes. Never accept a household identifier from the browser as authority.

### Data model

- User, Household, Membership, and authentication/session records.
- PlaidItem: household, environment, Plaid item ID, encrypted access token with key version, institution metadata, status, sync cursor, last success, safe error code and timestamps. Unique(environment, item ID).
- Account: internal UUID, household, Item, external account ID, name/mask/type/subtype/currency, active status. Unique(Item, external account ID). Missing accounts are marked unavailable rather than silently deleted.
- BalanceSnapshot: account, observation time, available/current/limit as nullable decimal values, currency and source. Null is not zero. Distinguish observed time from provider freshness; do not label cached data live.
- Transaction: account, provider transaction ID, exact decimal amount, currency, dates, pending state, pending transaction reference, description, removal status. Unique(Item, provider transaction ID), with account ownership checked.
- LinkAttempt: household/session binding, environment, short expiry and completion status, to reject replay and cross-session exchanges.
- SyncRun: Item, status/timing, sanitized request ID/error, counters; never raw token-bearing payloads.

Use PostgreSQL decimal types and decimal-safe arithmetic; do not sum money with JavaScript floating-point arithmetic. Preserve currency and Plaid sign conventions explicitly. Accounts and snapshots belong to the app; Plaid IDs are external mappings.

### Secrets and environments

Validate configuration at startup: DATABASE_URL, PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV, token encryption key/key version, session/auth settings, APP_URL, and optional registered redirect URI. No secret is NEXT_PUBLIC. Use authenticated encryption such as AES-256-GCM via a vetted implementation, random nonce per encryption, authentication tag, versioned format, and Item/environment binding as authenticated context. Keep keys outside the database and never store bank credentials. Avoid logging Link/public/access tokens, callback query strings, credentials, or raw banking responses. Do not cache sensitive pages in shared caches.

Default to Sandbox. Current Plaid guidance distinguishes Sandbox and Production; Trial is a plan allowing eligible real production use, not a separate API hostname. Do not assume a legacy Development endpoint. Before a live test, verify the user's dashboard product permissions, OAuth institution eligibility, quotas, and billing terms. Require explicit user action to switch credentials/environment or link real accounts. Tag data by environment and keep Sandbox/live databases separate.

### Linking flow

1. Authorized POST /api/plaid/link-token creates a short-lived LinkAttempt and calls /link/token/create with an opaque stable internal client_user_id. Configure country/language and initially Transactions only if that product is entitled; do not add Auth merely to read balances. Record requested history explicitly, starting with 90 days.
2. Browser initializes official Plaid Link using the returned link_token. Handle cancellation and expiration without creating a local Item.
3. onSuccess sends public_token and the local attempt identifier to authorized POST /api/plaid/exchange. Validate attempt/session/environment; server exchanges using /item/public_token/exchange. Never return the resulting access token to the browser.
4. Persist encrypted token and Item, retrieve accounts with /accounts/get, and save account/balance observations atomically where applicable. Treat browser institution/account metadata as hints; retrieve authoritative IDs from Plaid.
5. Enforce uniqueness and replay protection. Handle uncertain exchange or database failure with a recoverable connection state and a documented orphan cleanup/reconciliation path; never blindly retry a consumed public token. Do not merge connections based only on institution name: separate logins can be valid.
6. Display connection, accounts, status, last observation, and safe recoverable errors. Initial transaction availability can be delayed; zero initial results are not a linking failure.
7. Implement update mode for ITEM_LOGIN_REQUIRED and expired consent using an existing server-owned Item. Implement explicit disconnect via /item/remove, then clear the local token and mark disconnected after success; retain an error/retry state on failure. Explain whether historical data is retained and provide a separately confirmed local deletion action.

### OAuth and localhost

Implement /plaid/oauth callback and reinitialize Link using the original link token and receivedRedirectUri, tied to the original session/attempt with expiry. Keep the original token only for the short flow and clear it afterward. Do not log callback query parameters. Follow current Plaid OAuth requirements. Sandbox can exercise localhost flows; real OAuth requires a registered HTTPS redirect URI. If the desired bank requires it, propose an approved HTTPS development tunnel or hostname; do not open a tunnel automatically. Webhook reachability and browser OAuth redirection are separate concerns.

### Balances and manual transactions

Start with balances included by /accounts/get and label their observation time. Add an explicit, throttled refresh using /accounts/balance/get only after verifying product availability and billing; do not poll fresh balances on every page view.

After linking works, add an authorized manual sync endpoint and local CLI command sharing the same service. Use /transactions/sync per Item; persist cursor only with successfully applied data. Fetch all pages into a bounded staging mechanism outside a long database transaction; serialize runs for an Item using a robust database-backed lock/lease and check cursor version on commit. Apply added/modified/removed records and final cursor in one transaction. A mutation-during-pagination error restarts the entire batch from its original cursor. Failures must leave committed data/cursor consistent. Handle pending-to-posted transitions without counting both as spending. Use bounded retries/backoff for transient failures; expose reconnect-required errors separately. A UI refresh only reads the database unless the user explicitly requests sync.

Defer public webhooks and scheduling. Manual local sync requires no publicly reachable inbound endpoint. If webhooks are added later, require signature/JWK verification, allowed algorithm, timestamp/body-hash checks, bounded payloads, durable enqueue-before-acknowledge, duplicate-safe jobs, and the same per-Item synchronization lock. Never trust a webhook Item ID without matching a stored Item/environment.

### Screens and failure states

Provide sign-in, connections, accounts/balances, and a simple transactions page after phase two. Include connect/reconnect/disconnect, last sync, stale/unavailable data, loading, cancellation, institution outage, missing entitlement, rate-limit, and retry states. Keep secrets and provider internals out of UI errors. Do not display full account numbers. Provide a production readiness checklist in documentation, not as intrusive product UI.

### Acceptance and verification

Deliver two working increments: (1) authentication plus Sandbox linking/accounts/balances; (2) manual transaction sync and history. Before declaring each ready, run migration validation, type checking, lint, tests and production build. Provide exact commands and actual results.

Meaningful tests must cover unauthorized and cross-household access, CSRF/replayed exchange, encrypted-token roundtrip/tamper rejection and absence from client responses/logging, successful and failed exchange persistence, account upsert uniqueness, delayed initial transactions, multi-page sync, mutation restart, modified/removed records, pending-to-posted handling, concurrent sync, and rollback without cursor advancement. Mock provider calls for automated tests; offer a separately initiated Sandbox end-to-end check. Real institutions and Production data are never required for CI. Verify data survives database restart and restore a synthetic backup into a separate database.

README must include setup, encryption-key backup/rotation, Sandbox testing, deliberate live opt-in, OAuth HTTPS requirements, disconnect/data deletion behavior, and future deployment prerequisites. Finish with the implementation summary, checks actually run, and limitations. Do not claim the VM is ready to deploy.

## Sources and inspection provenance

Cloud findings derive from successful read-only gcloud auth, instance/machine-type/disk/address/firewall/effective-firewall/snapshot/resource-policy/bucket queries. Guest findings are explicitly unavailable after two SSH public-key failures. Repository findings derive from file inventory, README, git status/log/remotes. No package install or code tests were appropriate for the empty repository.

Technical references checked November 1, 2026:
- Next.js self-hosting: https://nextjs.org/docs/app/guides/self-hosting
- Google E2 machine family: https://docs.cloud.google.com/compute/docs/general-purpose-machines
- Plaid Link API: https://plaid.com/docs/api/link/
- Plaid OAuth: https://plaid.com/docs/link/oauth/
- Plaid Transactions API: https://plaid.com/docs/api/products/transactions/
- Plaid webhook verification: https://plaid.com/docs/api/webhooks/webhook-verification/
- Plaid environments and Trial: https://support.plaid.com/hc/en-us/articles/16110110883479-How-are-Sandbox-Production-Trial-plan-and-Limited-Production-different

These sources establish integration behavior, not the user's account-specific entitlements or a performance guarantee. Deployment and access changes require a separate approval.
