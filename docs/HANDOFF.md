# Handoff (2026-11-10)

Taleef Tamsal built WorkWell from April 2026 and hands it over on 2026-11-15. This page is for whoever
picks it up: what is finished, what waits on whom, which accounts the running stacks depend on, and how to
take them over or shut them down. The rules are in `CLAUDE.md`; how the system works is in `docs/guide/`.

## 1. Where it stands

- **`main` is tagged `v1.0.0`** (the handoff release). CI is green: 4,372 backend tests in three shards
  (84 self-skip without an optional input, `docs/guide/09-state-and-roadmap.md`) and 1,084 frontend tests,
  plus the MADiE eCQM gate, the CQL conformance suite and the Maui Playwright suite.
- **Three stacks run on synthetic data** (`docs/DEPLOY.md`): TWH (occupational, `twh.os.mieweb.org`),
  the Maui pilot sandbox (`maui.os.mieweb.org`, five ACO measures: cms122, cms125, cms2, cms130, cms165)
  and staging (live WebChart trial tenant, dispatch only). No stack holds real patient data.
- **The last requirements cycle is done.** Every stakeholder ask from July to October was checked against
  the code on 2026-10-30, and the remaining ones shipped: the attributed list end to end (#874, #875),
  the lead and staff seats (#880), the year change (#882), the scorecard cache (#884), logging a contact
  and contact preferences (#886), order options with admin-approved codes (#620), CMS137 retired after
  the CY2027 final rule (#889), a billed mammogram no longer counted as a result (#894) and custom
  measures kept apart from the CMS set (#895). `docs/JOURNAL.md` has a few lines on each.

## 2. What is left, and who it waits on

The milestone "Ready for January" holds the rest. None of it is blocked on code alone.

| Issue | What | Waits on |
|---|---|---|
| #854 | Rehearse 1 January 2027 on a copy of the Maui database | The next maintainer, in December (`pnpm rehearse:year-change`, DEPLOY.md "1 January 2027") |
| #847 | The measurement period is UTC; the practice is not | MIE: the practice's and WebChart's zones (OPEN_QUESTIONS 4.16) |
| #892 | MIE's answers to the 24 WebChart data asks | MIE |
| #876 | The 2027 CMS125 translation exposes no mammogram date | CMS's v15 package and test deck |
| #850 | Take the next `fqm-execution` release | Upstream |
| #663 | A Maui hang recovered only by hand (part B) | MIE: whether Create-a-Container restarts an exited process (OPEN_QUESTIONS 4.11) |
| #641, #564, #565 | Evaluate on data entry; appointments; chart write-back | MIE (WebChart APIs) |
| #640 | Order pick lists from the clinic's own catalog | The pilot group's order catalog |
| #626 | Hand the clinician seat to the pilot group | MIE and the pilot group |

**Three proposals from MIE (October 2026) need a decision before any code:**

1. **Compare WorkWell's results with WebChart's own `measure_calc` tables.** Needs read access to a WebChart
   database: MIE's seeded dev image, or a copy of the practice's, which holds PHI and is gated on HIPAA
   training.
2. **An OSHA proof of concept:** the audiogram measure (29 CFR 1910.95(g)) as a downloadable FHIR measure
   bundle and a small static site marked hypothetical. Needs locked decision 6 amended (occupational work
   is deferred behind the pilot) and somewhere to host it. Groundwork: `audiogram.cql` and
   `osha_hearing_sts.cql` in `backend-ts/measures/`, explained in `docs/guide/02-cql-and-authoring.md`.
3. **One npm calculation module embedded in WebChart**, populating and then replacing `measure_calc`.
   Touches locked decisions 1–3 (certification and the QDM engine); needs MIE's written direction.

**Owner decisions on file** (`docs/OPEN_QUESTIONS.md` §3, `docs/LOCKED_DECISIONS.md`): whether the
per-patient compliance API stays, whether a failed evidence upload stays on the timeline, the ~10-year
audit archive (#580, needs DDL), routing CMS68/CMS138/CMS951 on TWH, and an AI agent doing outreach
(AI_GUARDRAILS §7 says a human sends it). Issues outside the milestone carry the `future` label.

## 3. What the running stacks depend on

Everything below is held by the original developer unless the table says MIE. Values live only in the
repository's Actions secrets; none is in the code.

| Service | Holds | Secrets | On takeover |
|---|---|---|---|
| GitHub `Taleef7/workwell` | Code, issues, Actions, the secrets below | — | Transfer to MIE's org, or add an MIE admin |
| GHCR `ghcr.io/taleef7/workwell-*` | The images the containers run and heal from | (Actions token) | New namespace after a transfer: change `ghcr.io/taleef7` in the deploy, reconcile and CI workflows and DEPLOY.md. Keep the old images until the new ones deploy |
| MIE Create-a-Container (MIE) | The TWH, Maui and staging containers | `LAUNCHPAD_API_URL`, `LAUNCHPAD_API_KEY` | MIE issues a key to the new maintainer |
| Neon | One Postgres 16 project per stack (TWH `workwell-twh`, Maui, staging) | `DATABASE_URL_TWH`, `_MAUI`, `_STAGING` | §4 step 2 |
| Cloudflare R2 | `workwell-evidence-twh`, `workwell-evidence-maui` (also the terminology copies CI restores), `workwell-backups` (nightly dumps, 30 days) | `WORKWELL_BUCKET_S3_*_TWH`, `_MAUI`, `WORKWELL_BACKUP_S3_*`, `WORKWELL_R2_S3_ENDPOINT` | §4 step 3 |
| OpenAI | The three AI surfaces (each has a deterministic fallback) | `OPENAI_API_KEY` (required by the deploys) | A new key with a hard monthly limit |
| NLM UMLS / VSAC | Value-set expansion at build and on TWH | `WORKWELL_VSAC_API_KEY_VENDOR`, `_TWH` | **Not transferable**: a UMLS licence is personal. Get your own (free, from NLM) |
| npm `@work-well` | `@work-well/measure-engine` and `@work-well/measure-codegen` (`docs/PACKAGES.md`) | `NPM_TOKEN` | Ask to be added as a maintainer, or leave the published versions as they are |
| WebChart trial tenant (MIE) | Staging's live FHIR source | `WORKWELL_WEBCHART_PRIVATE_KEY_STAGING` | Register your own SMART key with MIE |
| Google Apps Script | Maui's failed-run alert, emailed to the original developer | `WORKWELL_ALERT_WEBHOOK_URL` | Deploy your own (DEPLOY.md "Failed-run alerts") or delete the secret |
| Generated | Sign-in signing keys, the Maui pilot password | `WORKWELL_AUTH_JWT_SECRET_*`, `WORKWELL_PILOT_PASSWORD_HASH_MAUI` | Rotate (DEPLOY.md "Required GitHub Secrets"); the plain password is recorded nowhere in the repo |

**CI needs none of these.** It runs without secrets, as it does on Dependabot's pushes: the terminology
steps then vendor without VSAC completion and say so.

## 4. Taking the stacks over

1. **The repository.** Transfer or add an admin (§3). GitHub redirects the old URLs after a transfer.
2. **The database.** Any Postgres 16 works; Neon is what the stacks use today (pick 16, not Neon's default
   17). Per stack: create the database, put its pooled URL in `DATABASE_URL_<STACK>`, set the role's 30 s
   `statement_timeout` (DEPLOY.md "Neon"), then dispatch the stack's deploy with `replace_existing: true`.
   The schema creates itself on boot, and the measures, segments and directory (Maui's 20,000-patient
   corpus included) are seeded from code. Outcomes and cases appear after the first run: the nightly at
   12:00 UTC, or `POST /api/runs/manual`. Run history, cases and the audit ledger come back only from a
   dump (BACKUP_DR_RUNBOOK §3.5). Keep the isolation guard: Maui's database must not share TWH's host.
3. **Storage.** Create the three buckets in your own account, set the R2 secrets, and redeploy. The boot
   probe fails loudly on a wrong bucket (`EVIDENCE_BUCKET_UNREACHABLE`).
4. **Keys.** OpenAI, your own UMLS key, your own alert webhook; rotate the JWT secrets and the pilot
   password. Redeploy each stack after a secret changes: a restart in place keeps the old environment.
5. **Check.** `/health` shows the deployed `build.sha` and routing problems 0; `scripts/smoke-shadow.sh`
   runs the post-deploy checklist. Read DEPLOY.md "Database compute cost" before changing any timer.
6. **Ownership in the docs.** `CLAUDE.md` names the maintainer as the owner of schema changes, merges and
   the owner decisions in `LOCKED_DECISIONS.md`.

## 5. Shutting the stacks down

Order matters. The health checks never touch the database, so a stack without one still reads green,
and the nightly backup would open an incident issue every night.

1. **Optional final dump:** run `backup-neon-nightly.yml` once by hand and keep the dumps from
   `workwell-backups`. The data is synthetic and regenerable (BACKUP_DR_RUNBOOK §5).
2. **Stop the schedules and deploys:**
   ```bash
   gh workflow disable reconcile-twh-mieweb.yml
   gh workflow disable reconcile-maui-mieweb.yml
   gh workflow disable backup-neon-nightly.yml
   gh workflow disable deploy-twh-mieweb.yml
   gh workflow disable deploy-maui-mieweb.yml
   ```
3. **Remove the containers** (TWH, Maui and staging, frontend and backend) in MIE's Create-a-Container
   manager, or ask MIE to.
4. **Delete the Neon projects**, then empty and delete the R2 buckets and their API tokens.
5. **Revoke the keys:** OpenAI, the npm token, the UMLS API key (regenerate it in your UTS profile), the
   Apps Script deployment and the WebChart trial key. Then delete the repository secrets.
6. **Update the links:** the repository homepage and the README's live-stack lines.

`ci.yml` stays enabled, and the code keeps running offline: `README.md` "Quick start" needs no database
or cloud account.

## 6. What is not in the repository

By the naming policy (LOCKED_DECISIONS §4A.6), meeting transcripts, client documents and the
ask-by-ask requirements map stay out of this public repository. MIE (Nicole) holds them. The issues and
`docs/OPEN_QUESTIONS.md` carry everything decided from them.

## 7. Where to read next

`CLAUDE.md` (rules, build and verify) → `docs/guide/README.md` (ten chapters) → `docs/ARCHITECTURE.md` →
`docs/DEPLOY.md` and `docs/BACKUP_DR_RUNBOOK.md` → `docs/ROADMAP_2026-08-30.md` (the pilot plan) →
`docs/OPEN_QUESTIONS.md` → the newest entries of `docs/JOURNAL.md`. The `.claude/skills/` folder holds four
short trap lists (deploy, WebChart, conformance, MCP) that an AI coding agent loads on its own.
