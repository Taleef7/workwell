# Deployment Guide

**Stack:** MIE Create-a-Container (frontend + backend) + Neon (Postgres) + OpenAI API.
**Status:** Current deployment reference for the merged WorkWell Measure Studio stack.
**Cost target:** keep the live stack under about $25/month.

> The MIE TWH stack below is the **sole live deployment**. The earlier Vercel + Fly.io
> public-preview stack is **decommissioned** — its setup is retained only as
> [Appendix A](#appendix-a--decommissioned-vercel--flyio-stack-historical-reference) for historical reference.

---

## MIE Create-a-Container Deployment (sole live stack)

The deployment runs on MIE's internal container platform (`os.mieweb.org`).
**One instance only: TWH** — Total Worker Health. Encompasses all OSHA safety + eCQM wellness measures.

| Service | Hostname | Image |
|---------|----------|-------|
| Frontend | `twh.os.mieweb.org` | `ghcr.io/taleef7/workwell-twh-frontend` |
| Backend API | `twh-api.os.mieweb.org` | `ghcr.io/taleef7/workwell-api` |

### Deployment workflow

Push to `main` triggers `.github/workflows/deploy-twh-mieweb.yml` which:
1. Builds the backend image tagged with `latest` + `sha-<SHA>`
2. Builds the frontend image with TWH branding baked in via build-args
3. Deploys both containers to MIE via `.github/scripts/deploy-mieweb-container.sh`

The deploy script talks to the MIE Container Manager **v1 API** (`<manager-origin>/api/v1`):
responses are wrapped in a `{"data": ...}` envelope, the create body uses `template` with
`services` as an array of flat objects, and job polling reads `.data.status` (success value
`"success"`). See the 2026-06-03 JOURNAL entries for the v1 migration details (PRs #55, #56).

### Required GitHub Secrets for MIE deploy

| Secret | Purpose |
|--------|---------|
| `LAUNCHPAD_API_URL` | MIE Create-a-Container API base URL |
| `LAUNCHPAD_API_KEY` | MIE API authentication key |
| `DATABASE_URL_TWH` | Neon pooled connection string for TWH instance |
| `OPENAI_API_KEY` | AI services (Draft Spec, Explain Why Flagged) |
| `WORKWELL_AUTH_JWT_SECRET_TWH` | JWT signing secret for TWH instance |

The deploy workflow maps these `*_TWH` GitHub secrets onto the backend container's runtime
environment variable names (e.g. `DATABASE_URL_TWH` → `DATABASE_URL`,
`WORKWELL_AUTH_JWT_SECRET_TWH` → `WORKWELL_AUTH_JWT_SECRET`) used in the
[environment variables reference](#environment-variables-reference) below.

### Backend runtime configuration (set by the workflow / container)

- `WORKWELL_INSTANCE=twh` — selects TWH seeding (see below)
- `SPRING_PROFILES_ACTIVE=prod`
- `WORKWELL_AUTH_ENABLED=true`, `WORKWELL_AUTH_JWT_SECRET=<strong-random-secret>`
- `WORKWELL_AUTH_COOKIE_SAME_SITE=None`, `WORKWELL_AUTH_COOKIE_SECURE=true`
- `WORKWELL_EMAIL_PROVIDER=simulated` (must stay `simulated` on the demo stack)

> **Refresh-cookie config:** the refresh-token cookie is set `SameSite=None; Secure`, and
> production startup **fails fast** if `WORKWELL_AUTH_COOKIE_SAME_SITE` is not `None` or
> `WORKWELL_AUTH_COOKIE_SECURE` is not `true`. With the frontend (`twh.os.mieweb.org`) and
> API (`twh-api.os.mieweb.org`) on split origins, this is what lets the browser send the
> cookie on the `POST /api/auth/refresh` fetch — otherwise silent token refresh fails and
> users are logged out on every reload.

### Instance seeding

The backend detects `WORKWELL_INSTANCE=twh` (set in the workflow) and seeds:
- All 4 OSHA surveillance measures with full CQL (Audiogram, HAZWOPER, TB, Flu)
- 4 HEDIS wellness catalog measures (Cholesterol, BMI, Diabetes HbA1c, Hypertension)
- All 49 CMS eCQM catalog entries (Draft, awaiting CQL authoring)

Total catalog: **60 measures** (see `docs/MEASURES.md` for the full breakdown).

### Manual re-deploy (force update existing containers)

Use `workflow_dispatch` with `replace_existing: true` from the GitHub Actions UI.

### Service startup & reboot policy

> "What happens if the server reboots — does WorkWell come back up on its own?"

There are two runtime contexts, and the answer differs:

**1. Live stack (`os.mieweb.org`) — MIE Create-a-Container.**
The `twh` and `twh-api` containers run on **MIE's Container Manager**, so the platform — not a
unit on a host we control — is responsible for restarting them after a host reboot. The deploy
create-payload (`.github/scripts/deploy-mieweb-container.sh`) does **not** currently set a restart
policy, so reboot recovery relies on the platform default. The backend image advertises itself to
the platform via the `org.mieweb.opensource-server.*` Docker label (see `backend/Dockerfile`),
which suggests the platform may also honor a restart/auto-start label.

> **Action — verify with MIE ops (not determinable from this repo):** (a) do containers
> auto-restart after an `os.mieweb.org` host reboot, and (b) is there a restart-policy field/label
> the Create-a-Container API accepts so we can make it explicit? If yes, add it to the create
> payload in `deploy-mieweb-container.sh`. (Same escalation path as the nginx SSE/504 item.)

**2. Self-hosted / VM / local — Docker Compose + systemd.**
For any host we *do* control, reboot recovery is fully handled and is the reference Doug asked for:

- **Per-container crash recovery:** every service in `infra/docker-compose.yml` is now
  `restart: unless-stopped`, so Docker restarts a crashed container automatically (and restarts
  the stack when the Docker daemon starts).
- **Boot-time startup:** an example systemd unit, `infra/systemd/workwell.service`, starts the
  whole compose stack on boot. Install + verification steps are in `infra/systemd/README.md`.

```bash
sudo systemctl enable docker                       # Docker starts on boot
sudo systemctl enable --now workwell               # stack starts now + on every boot
systemctl status workwell                          # verify
```

With both in place, a `sudo reboot` brings the entire stack back automatically (`docker compose ps`
shows all services `Up`).

---

## Environment variables reference

| Var | Where | Purpose |
|-----|-------|---------|
| `DATABASE_URL` | Backend | Pooled Neon connection for app runtime |
| `DATABASE_URL_DIRECT` | Backend | Direct Neon connection for Flyway migrations |
| `OPENAI_API_KEY` | Backend | AI calls (drafting and explanation surfaces) |
| `SPRING_PROFILES_ACTIVE` | Backend | Always `prod` in deployed env |
| `WORKWELL_INSTANCE` | Backend | `twh` selects the TWH seed set |
| `WORKWELL_AUTH_ENABLED` | Backend | Enable auth; set `true` in deployed env |
| `WORKWELL_AUTH_JWT_SECRET` | Backend | Required when auth is enabled; use a strong secret |
| `WORKWELL_AUTH_COOKIE_SAME_SITE` | Backend | Refresh-cookie SameSite. **Must be `None` in production** (split frontend/API origins). Default `Lax` for local same-origin dev. |
| `WORKWELL_AUTH_COOKIE_SECURE` | Backend | Refresh-cookie Secure flag. **Must be `true` in production** (required for SameSite=None). Default `false` for local HTTP dev. |
| `NEXT_PUBLIC_API_BASE_URL` | Frontend | Backend URL for fetch calls (origin-only, no `/api` suffix, no trailing whitespace) |
| `NEXT_PUBLIC_APP_NAME` | Frontend | App display name |
| `NEXT_PUBLIC_DEMO_MODE` | Frontend | Prefill login form for local/demo builds only; `true` **fails the production frontend build** |
| `WORKWELL_EMAIL_PROVIDER` | Backend | Outreach email provider. **Stays `simulated` on the demo stack (default + CLAUDE.md hard rule).** |
| `WORKWELL_EMAIL_SENDGRID_API_KEY` | Backend | SendGrid API key. Wiring exists in code but **must remain unset on the demo stack**; only set in an explicit non-demo deployment alongside `WORKWELL_EMAIL_PROVIDER=sendgrid`. |
| `WORKWELL_EMAIL_FROM_ADDRESS` | Backend | From address for outreach (default `noreply@workwell-demo.dev`). |
| `WORKWELL_EMAIL_FROM_NAME` | Backend | From display name (default `WorkWell Measure Studio`). |

`Where = Backend` vars are container environment on the MIE backend container (mapped from the
`*_TWH` GitHub secrets where applicable); `Where = Frontend` vars are build-args/env baked into
the MIE frontend image. `.env.example` at repo root mirrors this list (without values). Env vars
must be verified manually before deploy; the CI workflow does not validate deployment secrets.

### Email delivery (Sprint 6)

The demo stack runs `WORKWELL_EMAIL_PROVIDER=simulated`. Outreach actions never send a real
email — each attempt is logged and written to `outreach_delivery_log` with `status=SIMULATED`,
visible in the Admin → Outreach Delivery Log panel. SendGrid wiring (`com.workwell.notification.EmailService`)
exists for post-demo / non-demo use only and is exercised solely when both
`WORKWELL_EMAIL_PROVIDER=sendgrid` and `WORKWELL_EMAIL_SENDGRID_API_KEY` are set; if the
provider is `sendgrid` but no key is configured it degrades safely back to a simulated send.
Do not set `WORKWELL_EMAIL_SENDGRID_API_KEY` on the demo stack.

The non-prod `POST /api/admin/demo-reset` endpoint (admin-only, `@Profile("!prod")`) truncates
volatile demo tables including `audit_events`; it returns 403 under the `prod` profile.

## Neon (Postgres)

1. Project `workwell-twh`, region us-east, **Postgres 16**
2. **Pooled** connection string → `DATABASE_URL_TWH` GitHub secret (app runtime)
3. **Direct** connection string → used for Flyway migrations (`DATABASE_URL_DIRECT`)

Do not use `neonctl projects create` unless it supports `pg_version=16`; the CLI defaults to
Postgres 17 and is not compliant with the locked stack.

## OpenAI

1. Get API key from platform.openai.com
2. Set a hard monthly usage limit in billing
3. Store as the `OPENAI_API_KEY` GitHub secret only (never expose to the frontend)

## CI/CD

**Active deploy workflow:** `.github/workflows/deploy-twh-mieweb.yml`
- Triggers on every push to `main` and via `workflow_dispatch`
- Builds backend + frontend Docker images, pushes to GHCR, deploys both containers to MIE

**CI workflow:** `.github/workflows/ci.yml`
- Runs backend build + tests (8-way test sharding; ~11m30s wall-clock)
- Runs frontend lint
- Does not deploy (deploy is the separate workflow above)

## Health checks

- Backend: `GET https://twh-api.os.mieweb.org/actuator/health` → `{"status":"UP"}`
- Frontend: `GET https://twh.os.mieweb.org/` → 200 OK
- DB: `psql "$DATABASE_URL_DIRECT" -c "SELECT 1"` from any host with the Neon direct string

Post-deploy smoke checklist (MVP complete surface):
- `GET /actuator/health` -> `200`
- `GET /api/runs?limit=1` -> `200`
- `GET /api/cases?status=open` -> `200`
- `GET /api/exports/runs?format=csv` -> `200`
- `GET /api/exports/outcomes?format=csv&runId=<latest-run-id>` -> `200`
- `GET /api/exports/cases?format=csv&status=open` -> `200`
- `GET /api/audit-events/export?format=csv` -> `200`
- `GET /api/admin/integrations` -> `200`
- `POST /api/admin/integrations/mcp/sync` -> `200`
- `POST /api/cases/{id}/actions/outreach/delivery?deliveryStatus=SENT` -> `200`
- `GET /api/cases/{id}` confirms `latestOutreachDeliveryStatus=SENT`

## Rollback

### MIE containers
- Revert the offending commit on `main` (re-triggers `deploy-twh-mieweb.yml`), or
- Re-run the deploy workflow via `workflow_dispatch` at an earlier SHA with `replace_existing: true`.
  Each backend image is also tagged `sha-<SHA>` in GHCR for pinning a known-good build.

### Neon
Each schema migration creates a branch. Promote the previous branch to main from the Neon dashboard.

## Cost monitoring

Daily check while the stack is live:

- **Neon dashboard:** storage + compute consumed
- **OpenAI usage dashboard:** today's spend
- **MIE platform:** internal container hosting (no per-month cloud bill like the legacy Fly tier)

If any approaches limit, fix that day. Don't wait.

## Troubleshooting

**Neon connection limit hit**
- Use the pooled connection string (`DATABASE_URL`), not direct, in the app
- HikariCP `maximum-pool-size: 10` in `application.yml`
- Direct connection only for Flyway

**OpenAI 429**
- One retry with exponential backoff (1s, 2s)
- Surface "AI temporarily unavailable" in UI
- Fall back to rule-based explanation text
- Audit log records the failure

**Audit log missing entries after deploy**
- Check Spring profile is `prod`, not `dev`
- Verify migrations ran: `psql "$DATABASE_URL_DIRECT" -c "\dt"` — should list `audit_events`

**Case detail or outreach delivery endpoint returns 500 after deploy**
- Check for SQL operator compatibility in prepared statements.
- PostgreSQL JSON existence should use `jsonb_exists(payload_json, 'key')` in JDBC query text rather than the raw `?` operator when bind parameters are present.

**MCP server can't be reached**
- MCP is exposed at `/sse` + `/mcp/**` on the backend
- Verify the Claude Desktop config points to the deployed URL and sends an `Authorization` header with a valid WorkWell JWT
- Role gates apply: `/sse` and `/mcp/**` return 403 unauthenticated

**Backend deploy job fails at the MIE manager API**
- Confirm the API base resolves to `<manager-origin>/api/v1` (the origin serves the SPA; `/api` serves Swagger)
- Responses are `{"data": ...}` enveloped; the create body uses `template` + `services[]`; job polling reads `.data.status` (`"success"`)

---

## Appendix A — Decommissioned Vercel + Fly.io stack (historical reference)

> **Decommissioned — do not use.** None of the resources below are deployed any more.
> MIE TWH (above) is the sole live stack. This section is retained only so the earlier
> public-preview setup remains documented. Environment variable *names* are unchanged;
> on the current stack they are set on the MIE containers, not as Fly secrets or Vercel env.

Legacy stack layout:

| Layer | Service | Tier | Cost |
|-------|---------|------|------|
| Frontend | Vercel | Hobby | $0 |
| Backend | Fly.io | shared-cpu-1x, 512MB | ~$2/mo |
| Postgres | Neon | Free | $0 (3GB cap) |
| AI | OpenAI API | direct, budget-capped | variable |
| Domain | Vercel subdomain | n/a | $0 |

Notes from that era: Fly 256MB free OOMs Spring Boot (use 512MB). Fallback if Fly cost was a
problem: Render free tier (cold-start tradeoff, ~30s first hit per inactive period).

### Legacy prerequisites
- Fly CLI: `iwr https://fly.io/install.ps1 -useb | iex` (Windows) or `curl -L https://fly.io/install.sh | sh`
- Vercel CLI: `pnpm i -g vercel`

### Legacy Fly.io setup

```bash
cd backend
fly launch --no-deploy
fly secrets set DATABASE_URL=<neon-pooled>
fly secrets set DATABASE_URL_DIRECT=<neon-direct>
fly secrets set OPENAI_API_KEY=<key>
fly secrets set SPRING_PROFILES_ACTIVE=prod
fly secrets set WORKWELL_AUTH_ENABLED=true
fly secrets set WORKWELL_AUTH_JWT_SECRET=<strong-random-secret>
fly secrets set WORKWELL_AUTH_COOKIE_SAME_SITE=None
fly secrets set WORKWELL_AUTH_COOKIE_SECURE=true
```

> On the legacy stack the frontend (Vercel) and backend (Fly) were different registrable
> domains, so every browser→API call was **cross-site** and the refresh-token cookie had to be
> `SameSite=None; Secure`. (The same production fail-fast check applies on MIE today.)

`fly.toml`: `memory = "512mb"`, region closest to you (e.g., `ord`, `iad`), and
`min_machines_running = 1` for a stable remote MCP connection.

```bash
fly deploy
curl https://<app>.fly.dev/actuator/health  # expect {"status":"UP"}
```

### Legacy Vercel setup

1. Import GitHub repo, root directory `frontend/`
2. Framework: Next.js (auto-detected)
3. Env vars: `NEXT_PUBLIC_API_BASE_URL` = Fly app URL; `NEXT_PUBLIC_APP_NAME`; `NEXT_PUBLIC_DEMO_MODE` (local/demo only)

### Legacy rollback
- **Fly:** `fly releases list` then `fly releases rollback <version>`, or `git checkout <sha> && fly deploy`
- **Vercel:** Dashboard → Deployments → previous → Promote to Production

### Legacy troubleshooting
- **Fly OOM:** verify `memory = "512mb"`; reduce heap `JAVA_OPTS=-Xmx384m -Xss256k`; check `fly logs` for OOMKilled
- **Vercel build fails:** Node 20+; verify `NEXT_PUBLIC_API_BASE_URL`; clear build cache if backend types changed
- **DB from Fly machine:** `fly ssh console` then `psql $DATABASE_URL_DIRECT -c "SELECT 1"`

### Legacy domain / probe notes
- Vercel subdomain `workwell-measure-studio.vercel.app` was the demo frontend; Fly `workwell-measure-studio-api.fly.dev` the backend
- S0 `/runs` probe: `OPTIONS https://workwell-measure-studio-api.fly.dev/api/eval` expecting `200` + `Access-Control-Allow-Origin`
