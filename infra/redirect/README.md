# workwell.os redirect container

Minimal nginx image that issues a `301 Moved Permanently` from
`https://workwell.os.mieweb.org/` (and any path beneath it) to
`https://twh.os.mieweb.org/`.

## First-time deploy checklist (manual owner steps)

1. **Make the GHCR package public.**
   After the first workflow run pushes `ghcr.io/taleef7/workwell-redirect:latest`,
   go to `https://github.com/Taleef7/workwell/pkgs/container/workwell-redirect` →
   Package settings → Change visibility → Public.
   MIE's cluster pulls images anonymously, so the package must be public before
   the container can start.

2. **Run the workflow.**
   GitHub Actions → "Deploy workwell.os redirect (MIEWeb)" → Run workflow.
   For the very first deploy, `replace_existing` should be `false` (default).
   If the `workwell` hostname already exists in the MIE manager UI from the old
   non-TWH stack, set `replace_existing: true`.

3. **Verify.**
   ```
   curl -I https://workwell.os.mieweb.org/
   ```
   Expected: `HTTP/1.1 301 Moved Permanently` with
   `Location: https://twh.os.mieweb.org/`.

4. **Optional: deploy a workwell-api redirect.**
   If `workwell-api.os.mieweb.org` also needs to redirect, duplicate the
   `deploy-redirect` job in the workflow with `REDIRECT_HOSTNAME: workwell-api`
   and the same image. The nginx config redirects all paths unconditionally.

## Image

- Source: `infra/redirect/Dockerfile` + `infra/redirect/nginx.conf`
- Built image: `ghcr.io/taleef7/workwell-redirect`
- Base: `nginx:1.27-alpine` (minimal, < 10 MB)
