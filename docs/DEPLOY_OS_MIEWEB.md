# Deploying to MIE Open Source Proxmox

This runbook covers the additive OS MIEWeb deployment path for WorkWell Measure Studio. It does not replace the current Vercel frontend or Fly.io backend; those stay live during rollout and rollback.

## Target Architecture

- Frontend: `https://workwell.os.mieweb.org` from `ghcr.io/taleef7/workwell`
- Backend API: `https://workwell-api.os.mieweb.org` from `ghcr.io/taleef7/workwell-api`
- Database: existing Neon Postgres, unchanged
- Container manager: MIE Create-a-Container REST API at `https://manager.os.mieweb.org`
- Site: `1` (Phoenix DC)

## Why the Workflow Uses the REST API Directly

`mieweb/launchpad@main` derives the container hostname from `owner-repo-branch`. That is fine for one app per repo/branch, but WorkWell needs two containers from the same repo and branch:

- `workwell-api`
- `workwell`

The MIE REST API supports explicit `hostname`, `services`, and `environmentVars` fields on `POST /sites/{siteId}/containers`, so `.github/workflows/deploy-os-mieweb.yml` calls the API directly.

Current API limitation: JSON `PUT /sites/{siteId}/containers/{containerId}` only updates a few mutable container fields. It does not update services, environment variables, or restart a container. Because of that, a redeploy of an existing hostname deletes and recreates the container. Manual `workflow_dispatch` defaults to `replace_existing=false` so you do not delete a running container by accident. Pushes to `main` are treated as intentional redeploys after this PR is merged.

## One-Time API Key Setup

1. Go to `https://manager.os.mieweb.org`.
2. Open `API Keys` from the left navigation.
3. Click `+ New API Key`.
4. Use a description such as `WorkWell CI/CD`.
5. Click `Generate API Key`.
6. Copy the key immediately. The UI shows the full key once, and the server stores only a hash.

Add this key as the GitHub Actions repository secret `LAUNCHPAD_API_KEY`.

The API base URL secret should be:

```text
LAUNCHPAD_API_URL=https://manager.os.mieweb.org
```

Use the manager origin, not the Swagger UI route. The Swagger/OpenAPI console is visible at `/api`, but the JSON REST endpoints are served from the manager origin (`/sites`, `/sites/{siteId}/containers`, `/jobs`, and so on). If the secret is accidentally set to `https://manager.os.mieweb.org/api`, the workflow strips the trailing `/api` before making REST requests.

## GitHub Secrets To Add

Open GitHub repo settings:

1. Go to `https://github.com/Taleef7/workwell`.
2. Click `Settings`.
3. In the left sidebar, click `Secrets and variables`.
4. Click `Actions`.
5. Click `New repository secret` for each secret below.

Required secrets:

- `LAUNCHPAD_API_KEY`: MIE API key generated from `manager.os.mieweb.org`.
- `LAUNCHPAD_API_URL`: `https://manager.os.mieweb.org`.
- `DATABASE_URL`: Neon JDBC connection string for the existing production database.
- `WORKWELL_AUTH_JWT_SECRET`: new production-strength random secret, at least 32 characters.
- `OPENAI_API_KEY`: current OpenAI key used by Spring AI (`gpt-5.4-nano` configuration).

Not required for the current deployment:

- `ANTHROPIC_API_KEY`: not used by the current app configuration or OS MIEWeb workflow.

## How To Get `DATABASE_URL` From Neon

The backend is Java/Spring Boot, so `DATABASE_URL` should be a JDBC URL. Spring Boot's `spring.datasource.url` expects a `jdbc:...` URL. Do not paste a plain `postgresql://...` URL if Neon offers a JDBC option.

Preferred path:

1. Open Neon.
2. Select project `workwell-measure-studio-pg16`.
3. Select branch `production`.
4. Click `Connect`.
5. Keep `Connection pooling` enabled if this is the production pooled endpoint you already use.
6. Use database `neondb` and role `neondb_owner`, unless the current production deployment uses different values.
7. Click `Show password` if the password is hidden.
8. In the connection-string type dropdown, choose `JDBC` or `Java` if Neon offers it.
9. Copy the full JDBC string into the GitHub secret `DATABASE_URL`.

The value should look like this shape:

```text
jdbc:postgresql://ep-example-pooler.c-3.us-east-2.aws.neon.tech/neondb?user=neondb_owner&password=YOUR_PASSWORD&sslmode=require&channelBinding=require
```

If Neon only shows a generic URI like this:

```text
postgresql://neondb_owner:YOUR_PASSWORD@ep-example-pooler.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require
```

convert it to JDBC shape like this:

```text
jdbc:postgresql://ep-example-pooler.c-3.us-east-2.aws.neon.tech/neondb?user=neondb_owner&password=YOUR_PASSWORD&sslmode=require&channelBinding=require
```

Notes:

- Keep the `-pooler` host if Neon connection pooling is enabled.
- If the password contains special characters such as `&`, `?`, `#`, `%`, or spaces, prefer Neon's copied JDBC string so the password is encoded correctly.
- Do not commit this value to the repo. Store it only as a GitHub Actions secret.

## How To Create `WORKWELL_AUTH_JWT_SECRET`

This secret signs WorkWell access and refresh tokens. It must be random, private, and not the demo default.

PowerShell option:

```powershell
[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

OpenSSL option:

```bash
openssl rand -base64 48
```

Copy the generated string into GitHub as `WORKWELL_AUTH_JWT_SECRET`.

Do not use any of these:

- `workwell-demo-secret-change-me`
- `change-me`
- `secret`
- anything shorter than 32 characters

## GHCR Package Visibility

The MIE cluster pulls container images anonymously, so both GHCR packages must be public.

The packages will not appear until the workflow has pushed each image at least once.

After the first image push:

1. Go to `https://github.com/Taleef7?tab=packages`.
2. Open package `workwell`.
3. Click `Package settings`.
4. Scroll to `Danger Zone`.
5. Click `Change visibility`.
6. Choose `Public` and confirm.
7. Repeat the same steps for package `workwell-api`.

If a package page opens under the repository instead of your user profile, the same setting is still in `Package settings -> Danger Zone -> Change visibility`.

If the packages stay private, MIE container creation will fail when it tries to pull from GHCR, usually with a `401 Unauthorized` registry error.

## Workflow Behavior

The workflow is additive and does not modify the existing CI, Vercel, or Fly deployment workflow.

Triggers:

- `push` to `main`
- `workflow_dispatch`

Manual input:

- `replace_existing=false` by default. If `workwell` or `workwell-api` already exists, the workflow fails safely.
- `replace_existing=true` deletes and recreates an existing container with the same hostname.

Images pushed:

- Backend: `ghcr.io/taleef7/workwell-api:latest` and `ghcr.io/taleef7/workwell-api:sha-${GITHUB_SHA}`
- Frontend: `ghcr.io/taleef7/workwell:latest` and `ghcr.io/taleef7/workwell:sha-${GITHUB_SHA}`

Containers created:

- Backend hostname: `workwell-api`
- Backend service: HTTP, internal port `8080`, external host `workwell-api.os.mieweb.org`
- Frontend hostname: `workwell`
- Frontend service: HTTP, internal port `3000`, external host `workwell.os.mieweb.org`

Backend environment variables set by the workflow:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `JAVA_OPTS=-Xmx768m -Xms256m -Xss256k`
- `SPRING_PROFILES_ACTIVE=prod,production`
- `WORKWELL_CORS_ALLOWED_ORIGINS=https://workwell.os.mieweb.org`
- `CORS_ALLOWED_ORIGINS=https://workwell.os.mieweb.org` (compatibility alias)
- `WORKWELL_AUTH_COOKIE_SAME_SITE=None`
- `WORKWELL_AUTH_COOKIE_SECURE=true`
- `WORKWELL_AUTH_JWT_SECRET`

Why `prod,production`: the original request asked for `production`, but the current backend also has code guarded by `@Profile("!prod")`. Including both keeps the requested production profile while also disabling code that the existing Fly deployment disables under `prod`.

Frontend environment variables set by the workflow:

- `NODE_ENV=production`
- `NEXT_PUBLIC_API_URL=https://workwell-api.os.mieweb.org`
- `NEXT_PUBLIC_API_BASE_URL=https://workwell-api.os.mieweb.org`

The frontend API URL is also baked at Docker build time through the same value.

## First Deploy Sequence

Do not merge this PR until you are ready for the first real deployment.

Recommended first deploy:

1. Add all required GitHub secrets.
2. Merge the deployment PR to `main` when ready.
3. Let the workflow build and push both GHCR images.
4. Make both GHCR packages public as soon as they appear.
5. If the first container creation fails because the package was still private, re-run the workflow from GitHub Actions after making the packages public.

Alternative cautious route:

1. Merge only when ready.
2. Immediately cancel the first run after images have pushed but before deploy jobs, if needed.
3. Make packages public.
4. Re-run with `workflow_dispatch` and `replace_existing=false` for first create.

## Verification

Wait 1-2 minutes after the workflow reports success so the load balancer can reconfigure.

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

- Open `https://workwell.os.mieweb.org/` and confirm the public landing page loads.
- Click `Try the sandbox` or open `https://workwell.os.mieweb.org/sandbox` and confirm the demo workspace opens without manual credential entry.
- If needed, `https://workwell.os.mieweb.org/login` remains available as the explicit sign-in fallback.
- Confirm dashboard API calls go to `https://workwell-api.os.mieweb.org`.
- Reload a protected page and confirm the session survives refresh.

## Rollback

The existing Vercel and Fly deployment remains live throughout this PR.

If the MIE deployment misbehaves:

1. Do not change Neon data.
2. Disable `.github/workflows/deploy-os-mieweb.yml` in GitHub Actions or revert the merge commit that introduced it.
3. Keep serving users from:
   - Frontend: `https://workwell-measure-studio.vercel.app`
   - Backend: `https://workwell-measure-studio-api.fly.dev`
4. Delete the MIE containers through `manager.os.mieweb.org` if you want to stop the Proxmox deployment.
5. If needed, redeploy the known-good Vercel/Fly versions using the existing deployment paths.
