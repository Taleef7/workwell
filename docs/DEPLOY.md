# Deployment Guide

**Stack:** Vercel (frontend) + Fly.io (backend) + Neon (Postgres) + Anthropic API.
**Cost target:** under $25 through May 17, 2026.

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

## One-time setup (D1)

### Neon

1. Create project `workwell-measure-studio`, region us-east, **Postgres 16**
2. Copy **pooled** connection string (for app)
3. Copy **direct** connection string (for Flyway migrations)
4. Save as repo secrets: `DATABASE_URL`, `DATABASE_URL_DIRECT`

Do not use `neonctl projects create` unless it supports `pg_version=16`; the current CLI defaults to Postgres 17 and is not compliant with the locked sprint stack.

### Fly.io

```bash
cd backend
fly launch --no-deploy
fly secrets set DATABASE_URL=<neon-pooled>
fly secrets set DATABASE_URL_DIRECT=<neon-direct>
fly secrets set ANTHROPIC_API_KEY=<key>
fly secrets set SPRING_PROFILES_ACTIVE=prod
```

Edit `fly.toml`: `memory = "512mb"`, region = closest to you (e.g., `ord`, `iad`).

D1 stops here. Do **not** deploy until D2/S0.

D2 deploy verification:

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
4. D1 stops after project connection and env configuration. First deploy from `main` happens during D2/S0.

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
| `NEXT_PUBLIC_API_BASE_URL` | Vercel | Backend URL for fetch calls |
| `NEXT_PUBLIC_APP_NAME` | Vercel | App display name |

`.env.example` at repo root mirrors this list (without values). At present, env vars must be verified manually before deploy; the existing CI workflow does not validate deployment secrets or Vercel env configuration.

## CI/CD

GitHub Actions workflow `.github/workflows/ci.yml` currently:

- Runs the backend build
- Runs frontend lint
- Does not deploy Fly.io or Vercel
- Does not gate deploys or validate deployment env vars

Deployments are currently performed outside this workflow (for example, via Fly CLI and Vercel's own deployment flow).

## Health checks

- Backend: `GET /actuator/health` → `{"status":"UP"}`
- Frontend: `GET /` → 200 OK
- DB: from Fly machine, `fly ssh console` → `psql $DATABASE_URL_DIRECT -c "SELECT 1"`

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

Daily check from D2 onwards:

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

**MCP server can't be reached**
- MCP runs as separate process or endpoint (`/mcp`)
- Check Fly machine has port exposed if using stdio over HTTP
- Verify Claude Desktop config points to deployed URL

## Domain (optional)

Vercel subdomain `workwell-measure-studio.vercel.app` is fine for the demo. If buying a real domain later:
1. Buy on any registrar
2. Vercel: Settings → Domains → add, follow DNS instructions
3. Fly: `fly certs add api.<your-domain>`, follow DNS instructions
4. Update `NEXT_PUBLIC_API_BASE_URL` to new backend domain

## D2 notes (S0)

- Confirm the active Vercel project is `workwell-measure-studio`.
- Confirm Vercel Root Directory is `frontend`.
- For the S0 `/runs` probe, validate preflight before debugging POST:
  - `OPTIONS https://workwell-measure-studio-api.fly.dev/api/eval`
  - Expect `200` plus `Access-Control-Allow-Origin`.
- If probe UI shows `404` while direct POST works, check CORS/security config and redeploy Fly backend.
- Keep `NEXT_PUBLIC_API_BASE_URL` as origin-only (for example `https://workwell-measure-studio-api.fly.dev`), with no `/api` suffix and no trailing whitespace.
