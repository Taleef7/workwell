# Deployment Guide

**Stack:** Vercel (frontend) + Fly.io (backend) + Neon (Postgres) + Anthropic API.
**Status:** Current deployment reference for the merged WorkWell Measure Studio stack.
**Cost target:** keep the live stack under about $25/month.

---

## MIE Create-a-Container Deployment (Primary Demo Stack)

The primary demo deployment runs on MIE's internal container platform (`os.mieweb.org`).
**One instance only: TWH** — Total Worker Health. Encompasses all OSHA safety + eCQM wellness measures.

| Service | Hostname | Image |
|---------|----------|-------|
| Frontend | `twh.os.mieweb.org` | `ghcr.io/taleef7/workwell-twh-frontend` |
| Backend API | `twh-api.os.mieweb.org` | `ghcr.io/taleef7/workwell-api` |

### Deployment workflow

Push to `main` triggers `.github/workflows/deploy-twh-mieweb.yml` which:
1. Builds the backend image tagged with `latest` + `sha-<SHA>`
2. Builds the frontend image with TWH branding baked in via build-args
3. Deploys both containers to MIE via `deploy-mieweb-container.sh`

### Required GitHub Secrets for MIE deploy

| Secret | Purpose |
|--------|---------|
| `LAUNCHPAD_API_URL` | MIE Create-a-Container API base URL |
| `LAUNCHPAD_API_KEY` | MIE API authentication key |
| `DATABASE_URL_TWH` | Neon pooled connection string for TWH instance |
| `OPENAI_API_KEY` | AI services (Draft Spec, Explain Why Flagged) |
| `WORKWELL_AUTH_JWT_SECRET_TWH` | JWT signing secret for TWH instance |

### Instance seeding

The backend detects `WORKWELL_INSTANCE=twh` (set in the workflow) and seeds:
- All 4 OSHA surveillance measures with full CQL (Audiogram, HAZWOPER, TB, Flu)
- 4 HEDIS wellness catalog measures (Cholesterol, BMI, Diabetes HbA1c, Hypertension)
- All 47 CMS eCQM catalog entries (Draft, awaiting CQL authoring)

### Manual re-deploy (force update existing containers)

Use `workflow_dispatch` with `replace_existing: true` from the GitHub Actions UI.

---

## Stack

| Layer | Service | Tier | Cost |
|-------|---------|------|------|
| Frontend | Vercel | Hobby | $0 |
| Backend | Fly.io | shared-cpu-1x, 512MB | ~$2/mo |
| Postgres | Neon | Free | $0 (3GB cap) |
| AI | Anthropic API | direct, $20 hard cap | ~$5–15 actual |
| Domain | Vercel subdomain | n/a | $0 |

Fly 256MB free OOMs Spring Boot. Don't try.

Fallback if Fly cost is a problem: Render free tier (cold-start tradeoff, ~30s first hit per inactive period).

## Prerequisites

- GitHub account, repo `workwell-measure-studio`
- Fly CLI: `iwr https://fly.io/install.ps1 -useb | iex` (Windows) or `curl -L https://fly.io/install.sh | sh`
- Vercel CLI: `pnpm i -g vercel`
- Neon account + project created
- Anthropic API key with $20/mo hard cap set in console billing

## One-time setup

### Neon

1. Create project `workwell-measure-studio`, region us-east, **Postgres 16**
2. Copy **pooled** connection string (for app)
3. Copy **direct** connection string (for Flyway migrations)
4. Save as repo secrets: `DATABASE_URL`, `DATABASE_URL_DIRECT`

Do not use `neonctl projects create` unless it supports `pg_version=16`; the current CLI defaults to Postgres 17 and is not compliant with the locked stack.

### Fly.io

```bash
cd backend
fly launch --no-deploy
fly secrets set DATABASE_URL=<neon-pooled>
fly secrets set DATABASE_URL_DIRECT=<neon-direct>
fly secrets set ANTHROPIC_API_KEY=<key>
fly secrets set SPRING_PROFILES_ACTIVE=prod
fly secrets set WORKWELL_AUTH_ENABLED=true
fly secrets set WORKWELL_AUTH_JWT_SECRET=<strong-random-secret>
fly secrets set WORKWELL_AUTH_COOKIE_SAME_SITE=None
fly secrets set WORKWELL_AUTH_COOKIE_SECURE=true
```

> The frontend (Vercel) and backend (Fly) are different registrable domains, so
> every browser→API call is **cross-site**. The refresh-token cookie must be
> `SameSite=None; Secure` or the browser never sends it on the cross-site
> `POST /api/auth/refresh` fetch — silent token refresh fails and users are
> logged out on every page reload. Production startup now **fails fast** if
> `WORKWELL_AUTH_COOKIE_SAME_SITE` is not `None` or `WORKWELL_AUTH_COOKIE_SECURE`
> is not `true`.

Edit `fly.toml`: `memory = "512mb"`, region = closest to you (e.g., `ord`, `iad`), and keep `min_machines_running = 1` if you need a stable remote MCP connection.

Stop after wiring the secrets and project settings. Deploy only after the stack is provisioned and verified.

First deploy verification:

```bash
fly deploy
curl https://<app>.fly.dev/actuator/health  # expect {"status":"UP"}
```

### Vercel

1. Import GitHub repo, root directory `frontend/`
2. Framework: Next.js (auto-detected)
3. Env vars:
   - `NEXT_PUBLIC_API_BASE_URL` = Fly app URL (e.g., `https://workwell-measure-studio-api.fly.dev`)
   - `NEXT_PUBLIC_APP_NAME` = `WorkWell Measure Studio`
   - `NEXT_PUBLIC_DEMO_MODE` = `true` only for local/demo builds that should prefill the login form
4. Stop after project connection and env configuration. First deploy from `main` happens after the stack is provisioned and verified.

### Anthropic

1. Get API key from console.anthropic.com
2. Set $20/mo hard usage limit in billing
3. Save as Fly secret only (never expose to frontend)

## Env vars reference

| Var | Where | Purpose |
|-----|-------|---------|
| `DATABASE_URL` | Fly | Pooled Neon connection for app runtime |
| `DATABASE_URL_DIRECT` | Fly | Direct Neon connection for Flyway migrations |
| `ANTHROPIC_API_KEY` | Fly | AI calls (Explain Why Flagged, Draft Spec) |
| `SPRING_PROFILES_ACTIVE` | Fly | Always `prod` in deployed env |
| `WORKWELL_AUTH_ENABLED` | Fly | Enable stub auth; set `true` in deployed env |
| `WORKWELL_AUTH_JWT_SECRET` | Fly | Required when auth is enabled; use a strong secret |
| `WORKWELL_AUTH_COOKIE_SAME_SITE` | Fly | Refresh-cookie SameSite. **Must be `None` in production** (cross-site Vercel↔Fly). Default `Lax` for local same-origin dev. |
| `WORKWELL_AUTH_COOKIE_SECURE` | Fly | Refresh-cookie Secure flag. **Must be `true` in production** (required for SameSite=None). Default `false` for local HTTP dev. |
| `NEXT_PUBLIC_API_BASE_URL` | Vercel | Backend URL for fetch calls |
| `NEXT_PUBLIC_APP_NAME` | Vercel | App display name |
| `NEXT_PUBLIC_DEMO_MODE` | Vercel | Prefill login form for local/demo builds only |
| `WORKWELL_EMAIL_PROVIDER` | Fly | Outreach email provider. **Stays `simulated` on the demo stack (default + CLAUDE.md hard rule).** |
| `WORKWELL_EMAIL_SENDGRID_API_KEY` | Fly | SendGrid API key. Wiring exists in code but **must remain unset on the demo stack**; only set in an explicit non-demo deployment alongside `WORKWELL_EMAIL_PROVIDER=sendgrid`. |
| `WORKWELL_EMAIL_FROM_ADDRESS` | Fly | From address for outreach (default `noreply@workwell-demo.dev`). |
| `WORKWELL_EMAIL_FROM_NAME` | Fly | From display name (default `WorkWell Measure Studio`). |

`.env.example` at repo root mirrors this list (without values). At present, env vars must be verified manually before deploy; the existing CI workflow does not validate deployment secrets or Vercel env configuration.

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

## CI/CD

**Active deploy workflow:** `.github/workflows/deploy-twh-mieweb.yml`
- Triggers on every push to `main` and via `workflow_dispatch`
- Builds backend + frontend Docker images, pushes to GHCR, deploys both containers to MIE

**CI workflow:** `.github/workflows/ci.yml`
- Runs backend build + tests
- Runs frontend lint
- Does not deploy (deploy is separate workflow above)

## Health checks

- Backend: `GET /actuator/health` → `{"status":"UP"}`
- Frontend: `GET /` → 200 OK
- DB: from Fly machine, `fly ssh console` → `psql $DATABASE_URL_DIRECT -c "SELECT 1"`

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

Add Fly HTTP check every 30s on `/actuator/health`. Free, alerts on 3 failures.

## Rollback

### Fly
```bash
fly releases list
fly releases rollback <version>
```
Or redeploy a previous SHA:
```bash
git checkout <sha>
fly deploy
```

### Vercel
Dashboard → Deployments → previous → Promote to Production.

### Neon
Each schema migration creates a branch. Promote previous branch to main from Neon dashboard.

## Cost monitoring

Daily check while the stack is live:

- **Fly dashboard:** Usage tab, projected monthly
- **Neon dashboard:** storage + compute consumed
- **Anthropic console:** today's spend

If any approaches limit, fix that day. Don't wait.

## Troubleshooting

**Fly deploy fails with OOM**
- Verify `memory = "512mb"` in `fly.toml`
- Reduce JVM heap: `JAVA_OPTS=-Xmx384m -Xss256k`
- Check `fly logs` for OOMKilled

**Neon connection limit hit**
- Use pooled connection string (`DATABASE_URL`), not direct, in app
- HikariCP `maximum-pool-size: 10` in `application.yml`
- Direct only for Flyway

**Vercel build fails**
- Check Node version: 20+
- Verify `NEXT_PUBLIC_API_BASE_URL` is set in Vercel env
- Clear build cache if backend types changed: Vercel dashboard → Settings → Clear Cache

**Anthropic 429**
- One retry with exponential backoff (1s, 2s)
- Surface "AI temporarily unavailable" in UI
- Fall back to rule-based explanation text
- Audit log records the failure

**Audit log missing entries after deploy**
- Check Spring profile is `prod`, not `dev`
- Verify migration ran: `fly ssh console`, then `psql $DATABASE_URL_DIRECT -c "\dt"`
- Should see `audit_event` table

**Case detail or outreach delivery endpoint returns 500 after deploy**
- Check for SQL operator compatibility in prepared statements.
- PostgreSQL JSON existence should use `jsonb_exists(payload_json, 'key')` in JDBC query text rather than raw `?` operator when bind parameters are present.

**MCP server can't be reached**
- MCP runs as separate process or endpoint (`/mcp`)
- Check Fly machine has port exposed if using stdio over HTTP
- Verify Claude Desktop config points to the deployed URL and sends an `Authorization` header with a valid WorkWell JWT
- If the machine is scaling to zero, keep `min_machines_running = 1` so the SSE transport stays available for remote clients

## Domain (optional)

Vercel subdomain `workwell-measure-studio.vercel.app` is fine for the demo. If buying a real domain later:
1. Buy on any registrar
2. Vercel: Settings → Domains → add, follow DNS instructions
3. Fly: `fly certs add api.<your-domain>`, follow DNS instructions
4. Update `NEXT_PUBLIC_API_BASE_URL` to new backend domain

## Initial deployment notes

- Confirm the active Vercel project is `workwell-measure-studio`.
- Confirm Vercel Root Directory is `frontend`.
- For the S0 `/runs` probe, validate preflight before debugging POST:
  - `OPTIONS https://workwell-measure-studio-api.fly.dev/api/eval`
  - Expect `200` plus `Access-Control-Allow-Origin`.
- If probe UI shows `404` while direct POST works, check CORS/security config and redeploy Fly backend.
- Keep `NEXT_PUBLIC_API_BASE_URL` as origin-only (for example `https://workwell-measure-studio-api.fly.dev`), with no `/api` suffix and no trailing whitespace.
