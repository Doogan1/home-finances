# If this is ever hosted: prerequisites (not started, not approved)
> **Update (2026-11-23):** the app now runs privately on a homelab server over
> Tailscale; see [homelab-deployment.md](homelab-deployment.md). This checklist is
> still what applies before any **internet-facing** hosting.

**Nothing here has been done, and nothing in this repository deploys anything.**
No cloud, SSH, firewall, DNS, Nginx, IAM, billing or Plaid-production setting has
been changed, and none should be without explicit approval, item by item. This
document is the checklist to work through *if* you later decide to host the app,
based on the inspection recorded in [home-finances-spec.md](home-finances-spec.md)
(prepared Nov 1, 2026). Facts below marked **unverified** could not be checked at
the time and must be checked first.

## What the earlier inspection did and did not establish

Verified from the cloud side (read-only): one VM, `mallard-digital-vm`
(`e2-small`, shared-core, 2 GB RAM, Ubuntu 24.04 image, 20 GB boot disk that is
deleted with the VM), a reserved external IP, firewall rules that allow
TCP 80/443 from anywhere **and also 22 and 3389 from anywhere**, no snapshots, no
snapshot schedule, no storage buckets.

**Unverified, because guest SSH access failed** (`Permission denied (publickey)`):
the running OS and patch level, free RAM/CPU/disk under real load, swap, Nginx
version and existing server blocks, domain names, TLS certificates and renewal,
which ports are listening, the host firewall, SSH hardening, whether Docker or
PostgreSQL exist, any backup jobs, restore history, and monitoring. Do not silently
use `gcloud compute ssh` if it would upload keys; get access repaired or an
approved identity first.

## 0. Decide whether this VM is the right place

The VM also hosts other demo sites, so it shares their compromise and failure
boundary. A 2 GB shared-core machine can run one modest Next.js process and a
small PostgreSQL alongside light sites, but only if measured. Options, each
needing your approval and a cost/downtime estimate: keep it here with guardrails; a
small separate VM; managed app/database hosting. **Building the production image
should happen off the VM** (Next.js builds can exhaust 2 GB); this repository
already builds a self-contained Linux image (`npm run verify:image`).

## 1. Before anything is installed: inspect (read-only)

Once access works, and without copying secrets out of what you read:

- `cat /etc/os-release`, `uname -a`, pending security updates
- `free -m`, `df -h`, `uptime`, and CPU/memory **over days**, not one idle sample
- `sudo nginx -T` (existing sites, TLS, upstreams), certificate expiry and renewal
- listening sockets (`ss -tlnp`), the host firewall, enabled services and timers
- SSH configuration; whether Docker/PostgreSQL are already there and how
- any existing backup jobs and when a restore was last tested

## 2. Exposure and access

- **Review public SSH (22) and RDP (3389).** Restrict SSH to known addresses or an
  identity-aware path; remove RDP if nothing depends on it (check first). Account
  for the broad internal VPC rule that allows everything from `10.128.0.0/9`.
- **Bind narrowly even behind a cloud firewall:** the app on `127.0.0.1` only,
  PostgreSQL on loopback or a private container network, **no published database
  port**. (The local Compose file already publishes only `127.0.0.1:3000`, and
  nothing for the database.)
- **Service identity:** a dedicated, unprivileged service user for the app, owning
  a restricted secrets file (mode 600), separate from the demo sites' users and
  files. Review the VM service account's IAM separately; its permissions were
  never audited.
- Never run `next dev` in production.

## 3. Web server, TLS and the app

- A dedicated hostname and a valid TLS certificate; **do not disturb existing
  Nginx server blocks**.
- Nginx proxies to the loopback app port. Pass the usual forwarding headers.
  Next.js streams responses (it sends the page shell and then the signed-in
  content), so do not buffer them: send `X-Accel-Buffering: no` or set
  `proxy_buffering off` for this site.
- Set in the app's environment: `APP_URL=https://<hostname>` (it must be `https`
  off localhost; the app refuses plain-http cookies there), `NODE_ENV=production`.
  The login origin check compares against `APP_URL` exactly.
- **Rate limiting behind a proxy.** The app deliberately ignores
  `X-Forwarded-For` and counts sign-in attempts in one shared bucket (5 a minute),
  which suits one household and cannot be dodged by forging a header. That still
  works behind Nginx. If you later want per-address limits, configure Better Auth's
  trusted-proxy address settings (`advanced.ipAddress`) to trust **only** Nginx.
- **Content-Security-Policy is not set yet** (a policy untested against Plaid
  Link's script and frames would break linking). Add and test one before exposing
  the app to the internet.
- Authenticated responses are already `no-store`/private (checked against the
  production image); keep them out of any shared cache or CDN rule.

## 4. Running it

Either works: the production image under Compose (migrations as a **separate
job** holding the owner credential; the app container receives only
`DATABASE_URL`, the restricted role), or systemd plus a host PostgreSQL. Use
supervised restart. Keep database connections small (the app caps its pool at 5),
bound the logs, and set memory, disk and process alerts. Measure; if headroom is
inadequate, come back with a resize or separate-VM proposal.

Prefer a separately managed **data disk with deletion retention** for the
database (this needs approval). A persistent disk is not a backup.

## 5. Backups and keys (must exist before real data does)

The local `npm run backup` / `restore` tooling is the model, but a hosted setup
needs more:

- **Encrypted, off-VM** logical backups (`pg_dump`) **daily**: keep 7 daily and 4
  weekly copies. Local dumps here are *not encrypted* and live on the same machine.
- **A tested restore into a separate database**, on a schedule, with row counts and
  value comparison (what `npm run test:backup` does for synthetic data). Targets to
  aim for, to be confirmed by an actual restore: at most 24 hours of data loss and
  same-day recovery.
- **The token-encryption key backed up separately**, under restricted access, never
  bundled with a dump; documented rotation (`npm run keys:rotate`, see
  [local-development.md](local-development.md)).
- **Alert on backup failure.** Snapshots can supplement logical backups but do not
  replace verified restores. No backup automation has been installed.

## 6. Plaid and real accounts

- Real accounts need `PLAID_ENV=production` **and** `PLAID_LIVE_OPT_IN=yes`, a
  separate database and a separate encryption key
  ([local-development.md](local-development.md), "Going live").
- Confirm dashboard product permissions, OAuth institution eligibility, quotas and
  billing. Real OAuth banks need a registered **https** redirect address
  (`https://<hostname>/plaid/oauth`); the `http://localhost` allowance is Sandbox
  only. A public tunnel is never opened by this project; if you want one for
  development it must be your explicit decision.
- Webhooks (Plaid's `SYNC_UPDATES_AVAILABLE`) are not implemented. They would need
  a public endpoint with signature verification, durable enqueue-before-acknowledge
  and the same per-connection lease as manual sync. Until then, syncing is manual.

## 7. Acceptance before storing real data

Work through this and record the results; do not claim readiness without them:

- [ ] Guest access works and the section 1 inspection is done and written up
- [ ] Capacity measured under real load; headroom confirmed or a resize approved
- [ ] SSH/RDP exposure reviewed; service user and secrets file in place
- [ ] TLS hostname live; Nginx proxy tested, with streaming not buffered
- [ ] Content-Security-Policy added and tested with Plaid Link
- [ ] `npm run verify:image` passes on the exact image being deployed
- [ ] Encrypted off-VM backups running; **a restore tested end to end**; alerts on failure
- [ ] Encryption key backed up separately; rotation rehearsed
- [ ] Separate database and key for real data; opt-in flag set deliberately
- [ ] Your explicit approval for each of the changes above

Until then the app stays local, on Sandbox data.
