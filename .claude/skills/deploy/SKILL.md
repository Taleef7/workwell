---
name: deploy
description: Deploy or roll back WorkWell Measure Studio on the MIE Create-a-Container + Neon stack. Use when deploying, promoting, rolling back, rotating a secret, vendoring official terminology into a build, or debugging a failed deploy or a live outage on twh.os.mieweb.org.
---

# Deploying WorkWell Measure Studio

Read **`docs/DEPLOY.md`** now — it is the runbook (env vars, container setup, Neon wiring, rollback).
This skill exists to put the traps in front of you before you read it.

## Traps — check these first

1. **Secrets must exist BEFORE manifests are applied.** A missing secret blocks the DEPLOY, not just
   CI. See `docs/DEPLOY.md` §"Step 1a". This has bitten before; it is not a CI-only concern.
2. **`WORKWELL_EMAIL_PROVIDER=simulated` is mandatory on the demo stack.** SendGrid wiring exists but
   must not activate unless `WORKWELL_EMAIL_SENDGRID_API_KEY` is explicitly set with
   `WORKWELL_EMAIL_PROVIDER=sendgrid`, in a NON-demo environment. (`CLAUDE.md` hard rule.)
3. **Neon Free compute quota can exhaust and the monitoring will still read green.** On 2026-07-18 the
   live stack returned `{"error":"internal_error"}` from every DB-backed route for four days; root
   cause was HTTP 402 from the pooler, not a code bug. If every DB route fails at once, check quota
   before reading code.
4. **The routing lists are build args of the image, never container env** (ADR-045, #768):
   `WORKWELL_OFFICIAL_MEASURES` (TWH `cms122,cms125`; Maui the five pilot measures, cms137 retired
   2026-11-05, #889) and `WORKWELL_DERIVED_MEASURES` (the 2027 translations: Maui all five, TWH
   `cms125,cms122`) sit in each deploy's `build-backend-ts`
   build args and the routing gate's `EXPECTED_*`. No env array carries them, so a self-heal routes what
   its image was built with; `/health` reports `routing`. `official-flip-config.test.ts` refuses a list
   set anywhere else, and a measure without its MADiE gate or vendored artifact. Production leaves every `WORKWELL_WEBCHART_*` unset, so the
   WebChart seam gates staging only.
5. **Rollback = redeploy an earlier `twh-api-ts` `sha-<SHA>` image.** There is no migration to undo;
   the `workwell_spike` schema is self-creating and additive.

## Owner-only

Schema/DDL and secret rotation are the owner's (`CLAUDE.md`). Propose, show the change, and wait — never
apply. Taking the stacks over, or shutting them down: `docs/HANDOFF.md` §4–§5.
