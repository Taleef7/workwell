# WebChart Live Integration — Productionization Plan (2026-07-23)

> **For agentic workers:** implement task-by-task; steps use checkbox (`- [ ]`) syntax. Each phase
> ends with an explicit verification gate. Do not merge PRs — the owner reviews (Codex-implements /
> Claude-reviews house rule).

**Context.** As of 2026-07-23, WorkWell holds an authenticated SMART Backend Services client against a
**real WebChart instance** (`teatea.webchartnow.com`, a synthetic trial). `pnpm webchart:probe-auth`
proved `client_credentials` works (Bearer, 30 h) and per-patient FHIR composition reads live
(`Patient/12` → 239 Observations, etc.; population = 28 via `Patient?birthdate=gt1900-01-01` — **SUPERSEDED
2026-07-23: that query undercounts; the population is 35 via the full-range `birthdate=le9999-12-31`. See
JOURNAL + PR #330**). The full
transport + live-tenant machine (`smart-backend-auth.ts`, `webchart-client.ts`, `live-directory.ts`, the
`finishManualRun` live hook, roster/hierarchy/quality read models) is **already merged to `main`** and
green against HAPI/the WCDB shim — it has simply never met a real WebChart server. See
`docs/JOURNAL.md` 2026-07-23 and `docs/WEBCHART_TEATEA_RUNBOOK_2026-07-16.md`.

**Goal.** Make the live WebChart path genuinely production-grade: (1) fix the one real gap that stops it
running against a real WebChart server, (2) prove it end-to-end against live teatea, (3) complete the
live-tenant real-server verification against teatea and harden it, and (4) give it a real deployed
footprint via a **separate, non-demo staging environment** wired to teatea — all without ever wiring the
seam into the demo stack or letting CI depend on teatea.

**Non-goal (blocked-on-MIE, explicitly out of scope).** A PHI-capable environment (#267, C14/BAA),
production user auth / SSO (#265, C15), real multi-employer isolation (#269), and production volume
sizing (C16). teatea carries **no PHI**; this plan tops out at "live synthetic data through a real
authenticated client into a non-demo, non-PHI staging env."

## Global constraints (invariants — every phase honors these)

- **The demo stack stays seam-off, forever.** `twh.os.mieweb.org` / `workwell-twh` Neon keep every
  `WORKWELL_WEBCHART_*` **unset** — byte-identical behavior, guarded by the existing seam-off tests. The
  demo stack never receives real-EHR-derived data (`PRODUCTION_READINESS_2026-07.md` hard rule).
- **CI / `pnpm test` never touch teatea.** Automated live tests gate only on
  `WORKWELL_WEBCHART_LIVE_TEST_BASE_URL` → local HAPI (self-skipping, 2 s metadata probe). teatea is
  **manual-operator-only** — reached via the read-only CLI, never `pnpm test`. A stale runtime `.env`
  can never make the suite network-dependent (the dedicated test var is deliberately distinct from
  `WORKWELL_WEBCHART_BASE_URL`).
- **Secret hygiene.** The RS384 private key lives only in `~\.workwell\webchart-teatea.key` (local) and,
  for the staging env, in a GitHub secret / container env — **never committed, never logged, never
  pasted**. Probe/CLI output stays whitelisted (token_type / scope / expires_in only).
- **ADR-008.** CQL `Outcome Status` is the sole compliance authority; adapters only feed data.
- **No new dependencies.** WebCrypto + global `fetch` only.
- **teatea is synthetic (no PHI).** Even so, the staging env is treated as demo-grade, not PHI-capable.

---

## Phase 0 — clear the workspace (do first; ~30 min)

The 3 morning bug fixes + the 2026-07-23 journal entry sit uncommitted on `main`; a clean branch is
needed for the real work.

**Files (already modified, uncommitted):** `backend-ts/src/routes/employees.ts`,
`backend-ts/src/case/case-detail-read-model.ts`,
`frontend/app/(dashboard)/employees/[externalId]/page.tsx`, `docs/JOURNAL.md`.

- [ ] **0.1** Revert the 4 `wcdb-fhir-shim/sql/*.sql` files — the diff is line-ending-only (LF→CRLF)
      noise, no content change: `git checkout -- wcdb-fhir-shim/sql/`.
- [ ] **0.2** Branch `fix/employee-webchart-detail-papercuts` off `main`; commit the 3 bug fixes
      (percent-decode of `wc|` ids on the employee route + page; `statusProvesRecord` fallback in
      case-detail why_flagged) with a conventional message; open a PR — do not merge.
- [ ] **0.3** Branch `docs/journal-2026-07-23` (or fold the journal into the docs PR of Phase 3);
      keep the journal entry with its owning change.
- [ ] **Gate:** `cd backend-ts && corepack pnpm typecheck && corepack pnpm test` green;
      `cd frontend && npm run lint && npm run build` green.

---

## Phase 1 — server-capability fallback (the one real code gap)

The live client breaks against teatea at exactly one place. `listPopulation`
(`webchart-client.ts:251-256`) emits `GET /fhir/Patient?_count=100`; teatea **403s a bare `/Patient`**
and **rejects `_count`** (400) — both `WebChartNonRetryableError`, thrown on the first page, which the
run pipeline (`failOnPartialPage:true`) treats as fatal. `searchResources` (`283-286`) sets `_count` on
**every per-patient search too**, so the fix is "make `_count` omittable and add a Patient-enumeration
fallback," not a one-line Patient tweak.

**Design — an adaptive client (works against any server, zero config):**
- On the first `listPopulation` page, attempt the standard `Patient?_count=N`. On a non-retryable
  **400 or 403**, engage a fallback profile: drop `_count` and enumerate via an accepted indexed search
  (**SUPERSEDED by PR #328/#330**: the client never auto-guesses a demographic filter — the operator must
  supply a verified-complete `patientSearch`; `gt1900-01-01` was NOT complete), set a
  process-local `countRejected` flag, and re-attempt. If the fallback also fails, throw (still loud).
- Thread `countRejected` into `searchResources` so per-patient searches drop `_count` on the same server.
- Keep `resolveNext` + the off-origin guard unchanged (teatea may still page or may return one page).
- **Explicit overrides** (for deterministic deployed behavior, so staging need not rely on a runtime
  probe): `WORKWELL_WEBCHART_PATIENT_SEARCH` (use the full-range `birthdate=le9999-12-31`) and
  `WORKWELL_WEBCHART_DISABLE_COUNT=true` pin the quirk profile up front. Unset ⇒ adaptive probe/fallback.
- **HAPI/shim stay byte-identical** — the fallback only engages when the standard shape is rejected;
  standard servers never hit it.

**Files:**
- Modify: `backend-ts/src/engine/ingress/webchart/webchart-client.ts` (`listPopulation`,
  `searchResources`, the `fhirUrl`/query builders, `HttpWebChartClientOptions`).
- Modify: `backend-ts/src/engine/ingress/data-source.ts` (`DataSourceEnv`, `WebChartConfig`,
  `webChartConfigFromEnv` — carry the two new optional overrides).
- Modify: `backend-ts/src/engine/ingress/webchart/mock-http-conformance.test.ts` (add a teatea-like
  server harness — 403 bare `/Patient`, 400 on `_count`, 200 on `birthdate=` enumeration + on
  `?patient=X` without `_count`).
- Modify: `backend-ts/src/engine/ingress/webchart/webchart-client.test.ts` (if present) / add focused
  unit tests for the fallback + overrides.
- Modify: `docs/DEPLOY.md` (document the two new optional env vars in the `WORKWELL_WEBCHART_*` table).

- [ ] **1.0** Drive the fallback query choice from **teatea's CapabilityStatement** (already captured;
      Dave's explicit guidance 2026-07-23 — "feed the AI the metadata page"), not from probe-and-guess:
      confirm which Patient search params the server advertises as supported and pick the enumeration
      param from that list (`birthdate` is verified-working). The runtime probe/fallback remains the
      zero-config safety net for any server, but the default profile is grounded in the real metadata.
- [ ] **1.1** Write a failing `mock-http-conformance` case simulating teatea's rejections; assert the
      client still enumerates the full population and composes per-patient bundles.
- [ ] **1.2** Confirm RED.
- [ ] **1.3** Implement the adaptive fallback + explicit overrides; keep the standard-server path
      untouched.
- [ ] **1.4** Confirm GREEN; add tests proving HAPI-shape requests are byte-identical (no `birthdate`
      param, `_count` still present) when the server accepts the standard shape.
- [ ] **Gate:** `corepack pnpm typecheck && corepack pnpm test` green (HAPI live suite still self-skips
      unless `WORKWELL_WEBCHART_LIVE_TEST_BASE_URL` is set). Commit; open a PR — do not merge.

---

## Phase 2 — prove it against live teatea (manual, operator-run; the "real-life" proof)

This is **not** a CI step. It's an operator run against the real trial, recorded in the runbook.

- [ ] **2.1** Locally set `WORKWELL_WEBCHART_BASE_URL=https://teatea.webchartnow.com/webchart.cgi`,
      `WORKWELL_WEBCHART_CLIENT_ID=workwell`, `WORKWELL_WEBCHART_PRIVATE_KEY=<~/.workwell key>`
      (+ `WORKWELL_WEBCHART_SCOPE=system/*.read` as needed). Run the read-only CLI
      `pnpm evaluate:webchart-live` end-to-end over all 28 teatea patients → a per-measure outcome table.
      Confirm the Phase-1 fallback fires (population enumerated despite `_count` rejection) and per-patient
      composition succeeds.
- [ ] **2.2** Clinical prerequisite (runbook §4): for cms122 to evaluate instead of MISSING_DATA, the
      HbA1c-bearing teatea patients need a SNOMED 44054006 diabetes problem-list entry. Stamp it via the
      WebChart ingest tool (or note it as a known data gap if we don't want to write to teatea).
      **Decision point at execution:** writing to teatea is a data-entry action — confirm before running.
- [ ] **2.3** Record the live results (population count, per-measure outcome distribution, any additional
      server quirks) in `docs/WEBCHART_TEATEA_RUNBOOK_2026-07-16.md` §5 and update the #254 answer log
      (A2 pagination shape, A3 confirmed, A4/A5/A7/A8 as observed).
- [ ] **Gate:** a real teatea-backed CLI evaluation produces real non-MISSING_DATA outcomes for the
      observation-backed measures; results recorded.

---

## Phase 3 — live-tenant real-server verification + hardening (completes #262)

The live-tenant feature (roster/hierarchy/quality visualization of the `wc` tenant) is merged but its
`2026-07-17-webchart-live-tenant.md` **Task 3** (final verification + PR handoff) only ran against HAPI.
Now do the equivalent against real teatea locally, and harden any real-server gaps Phase 2 surfaced.

- [ ] **3.1** Locally, with the teatea seam configured, trigger an `ALL_PROGRAMS` run and confirm the
      background live fetch → CQL evaluation → persisted `wc|` outcomes path works against a real server
      (not just HAPI): `/compliance` (System = WebChart) shows real per-measure chips for the ~28
      subjects, `/programs/hierarchy` reconciles `All Systems = Σ tenants` including the `wc` tenant,
      and quality snapshots materialize.
- [ ] **3.2** Fold in any real-server robustness gaps from Phases 1–2 (e.g. per-patient `_count`
      handling, `link[next]` behavior teatea actually exhibits, degraded-bundle counts on real data).
- [ ] **3.3** Add an ADR (`docs/DECISIONS.md`) recording the teatea real-server verification + the
      adaptive-client capability fallback (supersede/extend ADR-028's contract notes with the observed
      teatea quirks). Update `docs/ARCHITECTURE.md` §7 (real-server failure/paging posture) and the
      runbook.
- [ ] **3.4** Check the live-tenant plan's Task-3 checkboxes that now apply, noting HAPI vs teatea.
- [ ] **Gate:** a local teatea-backed `ALL_PROGRAMS` run renders the `wc` tenant across all three
      dashboards with reconciling counts; full suite + typecheck + frontend build green; docs updated.
      Commit; PR — do not merge.

---

## Phase 4 — separate deployed staging environment wired to teatea (the "deployed/real-life" footprint)

A **distinct, non-demo** deployed environment running live against teatea — never the demo stack. This
has real infra + secret-management + owner/provisioning dependencies, so it is planned fully here and
**gated at execution** on owner actions (MIE hosting OK, GitHub secrets).

**Target shape:**
- New hostnames (proposal): `twh-staging.os.mieweb.org` (frontend) + `twh-staging-api-ts.os.mieweb.org`
  (backend) — separate MIE Create-a-Container containers from the demo stack.
- **Separate Neon project** (e.g. `workwell-staging`) — never the `workwell-twh` demo DB. teatea is
  synthetic so no BAA is needed, but the DB is isolated so a live-run bug can never touch demo data.
- Backend env: `WORKWELL_WEBCHART_BASE_URL/_CLIENT_ID/_PRIVATE_KEY` (+ `_SCOPE`, and the Phase-1
  overrides if we pin the teatea profile) → teatea; its own `WORKWELL_AUTH_JWT_SECRET`; its own DB.
- **Distinct GitHub secrets** (`*_STAGING`), including `WORKWELL_WEBCHART_PRIVATE_KEY_STAGING`
  (multi-line PEM). The demo deploy workflow and reconciler are untouched.
- **Scheduler OFF by default** on staging (or verified behind the DB-free due-gate) — the 2026-07-22
  Neon idle-polling outage lesson applies to every env with a Neon DB.
- **teatea trial runway:** Dave is extending the trial 30 days → **~3 months** (via Cornwell,
  confirmed in the 2026-07-23 meeting). So the staging env has real shelf life; still document the
  expiry as a known operational date and keep the env inert-by-config so it degrades gracefully when
  the trial ends (seam simply stops resolving).

**Product consideration (Dave's suggestion, 2026-07-23) — admin-configurable WebChart endpoint.** Dave
proposed a WorkWell **admin** screen to register WebChart endpoints (system URL + FHIR endpoint + our
registered `workwell` domain) so pointing at a WebChart system is config, not a redeploy. This is a
richer alternative to the env-var seam (multiple endpoints, no redeploy) but implies runtime-configurable
connection state (and, if persisted, touches the "no connection secrets in the DB" posture — the private
key would still need secure storage). **Decision deferred:** the env seam is sufficient for the single
teatea staging target now; the admin-endpoint UI is a Phase-5/product item, only if we need to point at
multiple WebChart systems without redeploying. Captured so it isn't lost.

**Files:**
- Create: `.github/workflows/deploy-staging-mieweb.yml` (parameterized clone of `deploy-twh-mieweb.yml`
  with the staging hostnames, secrets, and the WebChart env wired).
- Modify: `.github/scripts/deploy-mieweb-container.sh` only if staging needs a distinct code path
  (prefer parameterization / env, no fork).
- Modify: `docs/DEPLOY.md` (a "Staging environment (live WebChart against teatea)" section: hostnames,
  the `*_STAGING` secrets, the private-key handling, scheduler posture, teatea trial-expiry caveat).
- Modify: `.env.example` (mirror the staging var names, no values).

- [ ] **4.1** Confirm with the owner: MIE will host a second (staging) container set, and the owner will
      create the `*_STAGING` GitHub secrets (incl. the private key). **This is an owner/MIE gate — do not
      provision infra without it.**
- [ ] **4.2** Author `deploy-staging-mieweb.yml` (build the same images, deploy to the staging
      hostnames, wire the WebChart env). Dry-run / validate the workflow without triggering a live deploy.
- [ ] **4.3** Provision the separate Neon staging project; add its pooled URL as `DATABASE_URL_STAGING`.
- [ ] **4.4** Owner triggers the first staging deploy (`workflow_dispatch`). Verify: the staging URL
      boots with `webchart=on` in the seam-inventory boot line, a staging `ALL_PROGRAMS` run pulls the
      live teatea population, and the dashboards render the `wc` tenant on a **real deployed URL**.
- [ ] **4.5** Confirm the **demo** stack is provably unaffected (its seam-inventory line still reads
      `webchart=off`; a demo route smoke check is green).
- [ ] **Gate:** a real deployed staging URL evaluates live teatea data end-to-end; the demo stack is
      byte-identical; the teatea trial-expiry caveat is documented.

---

## Phase 5 — buildable-now prod-readiness follow-ons (named; not this pass unless time allows)

Sequenced after Phases 1–3 land, gated on the real-server behavior they reveal:

- **#263 delta / incremental evaluation (content-hash).** Design is decided (no `_lastUpdated` on
  WebChart ⇒ content-hash change detection). Cuts the cost/time of repeated live runs — material once
  staging runs on a schedule. Owner-gated `eval_state` DDL.
- **Real provider/location attribution (B10).** Every `wc` subject is pinned to one placeholder
  site/provider (`WebChart` / `wc-provider-1`). Real attribution needs the WebChart provider/location
  keys (B10 assumption-register item) — improves the hierarchy fidelity.
- **#187 real WebChart identity sources.** The E15 cross-system identity layer over real WebChart
  records (follows #262; needs B11 identity keys).
- **#264 observability for live runs.** Ensure the failed-run alert path fires on a live-population fetch
  failure (it should already, via `LivePopulationPreparationError` → `failPlannedRun`); confirm against
  a deliberately-broken staging fetch.

---

## Decision & dependency ledger

| Item | State | Blocker |
|---|---|---|
| Live SMART auth (A3) | ✅ done 2026-07-23 | — |
| `_count`/`/Patient` fallback | Phase 1 | code only |
| Live teatea CLI proof | Phase 2 | operator run (+ optional teatea write for cms122) |
| Live-tenant real-server verify | Phase 3 | Phases 1–2 |
| Deployed staging env | Phase 4 | **owner/MIE** (hosting OK + `*_STAGING` secrets) + Neon project |
| #263 delta-eval | Phase 5 | owner-gated `eval_state` DDL |
| Real attribution / #187 identity | Phase 5 | B10/B11 keys |
| PHI env #267 / auth #265 / tenancy #269 | out of scope | **MIE** (C14/C15/design) |

**Guardrail restated:** the demo stack seam stays off; CI never hits teatea; teatea is synthetic-only;
the private key never leaves secret storage; CQL stays the sole authority.

## Collaboration / owner action items (from the 2026-07-23 meetings — not code)

Tracked here so they aren't lost; none block the engineering phases above.

- **teatea trial extension** — Dave → Cornwell to extend 30 days → ~3 months. Owner: watch for the
  updated expiry date and record it in the runbook when confirmed.
- **HL7 CQI Work Group** — Doug asked Taleef to attend the HL7 **Clinical Quality Information** Work
  Group meetings (on Nicole's behalf) and report back on FHIR quality-measure standards direction.
  Nicole to drop the WG link. Owner action, recurring.
- **Layout-manager folder** — Dave to zip and share WebChart's layout-manager folder to enable
  AI-driven schema mapping for FHIR output. **This feeds the CQL→SQL / WCDB shim track (ADR-034/#292),
  not this live-FHIR plan** — when it arrives, it's the input for remapping the shim's read model to a
  new schema (the ADR-025 parity gate re-runs on any schema change). Note for that separate thread.
- **Scheduling** — Taleef ↔ Nicole to set up recurring technical-collaboration meetings (Dave
  facilitating access). Nicole = quality lead + hiring gate (3–4×/week cadence per prior notes);
  Bridget schedules (call, don't email).
- **Strategic direction (context, not scope)** — the meeting surfaced a payer / prior-authorization
  interoperability horizon (Da Vinci CRD/DTR/PAS, Inferno, Drummond certification; clearinghouses
  Availity / Change Healthcare / Edifecs; FHIR/payer vendors Smile Digital Health / Onyx / ZeOmega /
  Medplum). Well beyond this plan, but signals where WorkWell may head after live WebChart integration.
  Nicole owns the payer-vendor market-research item.
