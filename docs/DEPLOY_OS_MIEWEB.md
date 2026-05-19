# Deploying to MIE Open Source Proxmox

This runbook covers the additive OS MIEWeb deployment path for WorkWell Measure Studio. It does not replace the current Vercel frontend or Fly.io backend; those stay live during rollout and rollback.

## Target Architecture

- Frontend: `https://workwell.os.mieweb.org` from `ghcr.io/taleef7/workwell`
- Backend API: `https://workwell-api.os.mieweb.org` from `ghcr.io/taleef7/workwell-api`
- Database: existing Neon Postgres, unchanged
- Container manager: `mieweb/launchpad@main` via `.github/workflows/deploy-os-mieweb.yml`

## One-Time Setup

1. Go to `https://manager.os.mieweb.org`.
2. Open `API Keys` from the main navigation.
3. Click `+ New API Key`.
4. Optionally enter a description such as `WorkWell CI/CD`.
5. Click `Generate API Key`.
6. Copy the key immediately. The UI shows the full key once, and the server stores only a hash.

Add these GitHub Actions repository secrets before the first deploy:

- `LAUNCHPAD_API_KEY`: API key generated in the manager UI.
- `LAUNCHPAD_API_URL`: expected to be `https://manager.os.mieweb.org`, but confirm with MIE admins because the launchpad docs call it the create-a-container server base URL rather than spelling out the exact value.
- `DATABASE_URL`: existing Neon JDBC URL used by the backend.
- `WORKWELL_AUTH_JWT_SECRET`: production-strength JWT secret, at least 32 characters and not a demo/default value.
- `ANTHROPIC_API_KEY`: requested for this deployment path.
- `OPENAI_API_KEY`: currently used by the Spring AI configuration in `backend/src/main/resources/application.yml`.

After the first GHCR push, make both packages public because the cluster pulls images anonymously:

- `ghcr.io/taleef7/workwell`
- `ghcr.io/taleef7/workwell-api`

In GitHub, open each package settings page, then use `Package settings -> Danger Zone -> Change visibility -> Public`.

## Workflow Behavior

The workflow is additive and does not modify the existing CI, Vercel, or Fly deployment workflow.

Triggers:

- `push` to `main`
- `workflow_dispatch`

Images pushed:

- Backend: `ghcr.io/taleef7/workwell-api:latest` and `ghcr.io/taleef7/workwell-api:sha-${GITHUB_SHA}`
- Frontend: `ghcr.io/taleef7/workwell:latest` and `ghcr.io/taleef7/workwell:sha-${GITHUB_SHA}`

Launchpad site:

- Current workflow default: `site_id: 1`
- Docs confirm `site_id` defaults to `1`; confirm with MIE whether `1` is Phoenix DC and whether `2` is Fort Wayne before first production cutover.

## Verification

Wait 1-2 minutes after launchpad reports success so the load balancer can reconfigure.

Backend health:

```bash
curl -fsS https://workwell-api.os.mieweb.org/actuator/health
curl -fsS https://workwell-api.os.mieweb.org/api/health
```

Expected backend signals:

- `/actuator/health` returns an UP health response.
- `/api/health` returns `{"status":"ok"}`.

Frontend smoke test:

```bash
curl -I https://workwell.os.mieweb.org
```

Browser checks:

- Open `https://workwell.os.mieweb.org/login`.
- Sign in with the demo credentials.
- Confirm dashboard API calls go to `https://workwell-api.os.mieweb.org`.
- Reload a protected page and confirm the session survives refresh.

## Rollback

The existing Vercel and Fly deployment remains live throughout this PR.

If the MIE deployment misbehaves:

1. Do not change Neon data.
2. Revert the merge commit that introduced `.github/workflows/deploy-os-mieweb.yml` or disable the workflow in GitHub Actions.
3. Continue serving users from:
   - Frontend: `https://workwell-measure-studio.vercel.app`
   - Backend: `https://workwell-measure-studio-api.fly.dev`
4. If needed, redeploy the known-good Vercel/Fly versions using the existing deployment paths.

## Known Clarifications Before First Deploy

- `LAUNCHPAD_API_URL`: docs imply `https://manager.os.mieweb.org`, but the launchpad page only names it as the create-a-container server base URL.
- `site_id`: docs say the default is `1`; confirm `1 = Phoenix DC` and whether `2 = Fort Wayne` for this app.
- Two-container deployment: the current `mieweb/launchpad@main` action appears to derive container names from `owner-repo-branch` and does not document a hostname/container-name override. Because WorkWell needs separate frontend and backend LXC containers from the same repo and same `main` branch, MIE admins should confirm how to create `workwell` and `workwell-api` as distinct containers with launchpad before merging/running the deployment.
- Spring profile naming: this workflow sets `SPRING_PROFILES_ACTIVE=production` as requested. The existing Fly deployment uses `prod`, and some code paths specifically check `@Profile("!prod")`, so confirm whether the MIE deployment should use `production` only or `prod,production`.
