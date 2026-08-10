# Pass 1 — Code & Bug Review

**Fable Deep Review · 2026-07-02 · WorkWell Measure Studio**

Method: six parallel focused review agents (auth/RBAC, run/case/audit pipeline, stores floor+ceiling, program/identity/segment/quality read models, engine/CQL/AI/MCP/order, frontend), each producing file:line-cited findings; every High finding independently re-verified in source by the coordinating reviewer; live-stack corroboration where a finding is observable in production (noted inline). Static gates run this session: backend `pnpm typecheck` clean + **840 tests / 839 pass / 1 pg-skip / 0 fail**; frontend `eslint` clean (1 warning in a test mock), **107 vitest pass**, `next build` green.

**Headline: no Critical findings.** ADR-008 (CQL `Outcome Status` is the sole compliance authority) was verified to hold across every module — AI, forecast, orders, segments, identity, quality snapshots, and standards are all genuinely descriptive; none writes or influences `outcomes.status` (see "Verified solid" at the end). The highest-impact defects are (a) the population run pipeline violating the "every state change writes an audit_event" hard rule, (b) case-upsert clobbering operator workflow state, (c) two measures whose CQL matches *any* Condition on the real-data ingress path, and (d) several unbounded read paths that the 120k scale tenant turns into live timeouts.

All findings reconciled against `docs/JOURNAL.md`, `docs/QA_SMOKE_TEST_2026-06-20.md`, and the PR #181 audit; each is marked **NEW** / **STILL-OPEN** / **REGRESSED**. Everything below is NEW unless marked otherwise — this review reached code paths the prior audits did not.

---

## High findings

### H1 — Population run pipeline writes NO audit events for runs or case transitions — violates the "no exceptions" hard rule · NEW
`backend-ts/src/run/run-pipeline.ts:174-258`; case stores `case-store-sqlite.ts:53-106` / `case-store-postgres.ts:56-101`.
A manual/scheduled population run creates the run row, persists outcomes, and creates/reopens/resolves cases — none of it writes an `audit_events` row. No writer exists for `RUN_STARTED`/`RUN_COMPLETED`/`CASE_CREATED`/`CASE_UPDATED`/`CASE_RESOLVED` outside the rerun-to-verify path (`case-rerun.ts`) and test fixtures — yet `run/employee-profile.ts:103-107` maps those very event types, and ARCHITECTURE §5.4/§5.6 + CLAUDE.md ("Every state change writes `audit_event` — no exceptions") claim they exist. The highest-volume state change in the system is the one that isn't audited.
**Blast radius:** a nightly `ALL_PROGRAMS` run opens/closes hundreds of cases with zero ledger record; run audit packets' `auditEvents` sections are near-empty; the case timeline shows no creation event.
**Remedy:** emit `RUN_COMPLETED` in `finishManualRun` (deps.events is already threaded for E16) and `CASE_CREATED/UPDATED/RESOLVED` from the upsert disposition (the store already RETURNs the row).

### H2 — Case upsert clobbers operator workflow state on every population run · NEW
`case-store-sqlite.ts:80-87`, `case-store-postgres.ts:77-84` (verified: `DO UPDATE SET status = excluded.status …` unconditionally).
Deterministic failure modes: (1) a CM schedules an appointment (case → IN_PROGRESS); the nightly run re-evaluates the still-OVERDUE subject and flips it back to OPEN — the workflow state is silently discarded, and per H1, unaudited. (2) A manually-CLOSED case is reopened (`closed_at=NULL`) but `closed_reason`/`closed_by` are left populated — an internally inconsistent row and a silently undone human decision. (3) The RESOLVE branch rewrites `closed_at` to "now" on every subsequent compliant run, so closure timestamps drift forward.
**Remedy:** state-aware conflict branch (preserve IN_PROGRESS; clear `closed_reason`/`closed_by` on reopen; make RESOLVE a no-op for already-terminal rows), and make reopen-after-manual-close an explicit, audited decision.

### H3 — HAZWOPER + TB CQL matches ANY Condition — wrong compliance answers on the real-data path · NEW
`backend-ts/measures/hazwoper.cql:12-16`, `tb_surveillance.cql:12-16` (verified: `exists([Condition])` / `Count([Condition]) > 1`), and confirmed live in the committed executed ELM (`HazwoperSurveillance-1.0.0.elm.json` — empty codeFilter).
The other 12 runnable measures use inline code-scoped Condition filters; `docs/MEASURES.md` claims **all** were converted — these two never were. The synthetic pipeline masks it (bundles only ever contain that measure's own conditions), but `pnpm evaluate` (E2) and `evaluateBundle`/`evaluateBatch` (E12 — the advertised path for real FHIR data) accept arbitrary bundles: a patient with two unrelated conditions evaluates **EXCLUDED** for TB surveillance; one unrelated condition makes anyone "In HAZWOPER Program". CQL *is* the compliance authority (ADR-008), so this is a compliance-correctness bug, severity capped only because no real data flows yet.
**Remedy:** rewrite both defines with the existing bindings (`tb-program`/`tb-exemption`, `hazwoper-program`/`hazwoper-exemption` in `measure-bindings.ts:50,55`), recompile ELM, add a "foreign conditions present" golden regression.

### H4 — Unbounded 120k-row reads on run detail, QRDA, MeasureReport, and outcomes CSV · NEW (live-confirmed)
`backend-ts/src/routes/runs.ts:316` (outcomes grid), `:324` (QRDA), `:348` (MeasureReport), `export/export-csv.ts:84` (outcomes CSV) — all call `listOutcomes(runId)` with no cap.
The 14 `seed:scale` runs are ordinary COMPLETED MEASURE runs visible in `/api/runs`; any of these endpoints called with a scale run id materializes 120,000 hydrated rows in the single-replica worker. The P0 fixed in #219 (`countOutcomesByStatus`) covered the run *list*; these four detail paths were missed. **Live measurements this session:** MeasureReport summary on seed run `cad76951` = **23.1s**, QRDA = **35.4s**, outcomes CSV = **43.4s to first page** — all one cold cache away from the 60s gateway timeout, and each one is a memory spike that can degrade live traffic.
**Remedy:** gate by run identity (`triggered_by='seed:scale'` → aggregate-only response), page the outcomes grid via a `listOutcomes(runId, {limit, offset})`, and build QRDA/MeasureReport population counts from `countOutcomesByStatus` (the counts are all they need).

### H5 — `outcomes` has no index on `subject_id` or `measure_id` — hot queries seq-scan 1.68M live rows · NEW (live-corroborated)
`stores/postgres/schema-pg.ts:58-59` (only `run_id` indexed); `outcome-store-postgres.ts:134-136` (`listOutcomesForEmployee` — employee profile, MCP tools, the E15 merged timeline), `:158-159` (`listOutcomesForMeasure` — risk outlook, data readiness).
Every employee-profile or person view is a full heap scan + sort over ~1.68M rows on Neon. The Java-era schema had `outcomes_employee_measure_period_idx` (DATA_MODEL §3.9); the spike schema silently dropped it. Related live evidence: first-hit `/api/compliance/roster` = **11.8–12.5s**, `/api/hierarchy/rollup` = **5–7s** every hit (see also M16).
**Remedy (owner-gated DDL):** `CREATE INDEX IF NOT EXISTS spike_outcomes_subject_idx ON workwell_spike.outcomes (subject_id, evaluated_at DESC)` + a `measure_id` index; mirror on the floor.

### H6 — `pg.Pool` has no `'error'` listener — an idle-client drop crashes the whole worker · NEW
`stores/postgres/pg-database.ts:35-37`; no `.on("error"` anywhere in `backend-ts/src`.
`pg` emits `'error'` on the Pool when an idle pooled connection is severed — which Neon's pooler and compute-suspend do routinely. An unhandled `'error'` event is a process crash; the self-heal reconciler masks it only after up to 15 minutes, and an in-flight `ctx.waitUntil` ALL_PROGRAMS run dies mid-write (orphaned RUNNING → 30-min recovery window).
**Remedy:** `pool.on("error", log)` in `createPgPool`; tune `idleTimeoutMillis`/`max` for the Neon pooler.

### H7 — Hierarchy rollup counts in-flight RUNNING runs' partial outcomes · NEW
`program/hierarchy-rollup.ts:97-99` — the live-row scan never checks `isCompletedRun(r.runStatus)`, though every sibling read model does (`program-read-models.ts:149`, `roster-read-model.ts:84-85`, order proposals), and the *scale branch of the same function* requires COMPLETED (line 193).
Mid-run, `/programs/hierarchy` selects the in-flight run's partial rows for every measure — the tree's counts bounce and disagree with `/programs` (which was explicitly fixed for this exact bug class in #181: "the Evaluations count no longer bounces"). The docstring ("aggregates the SAME outcome rows the programs overview uses") is currently false. No test exercises a RUNNING run here.
**Remedy:** add `isCompletedRun(r.runStatus)` at line 98 (already exported from `rollup-shared.ts`) + a regression test.

### H8 — Identity UNLINK of the hub record shatters the remaining members of a 3+-record component · NEW
`identity/identity-model.ts:161-174` (auto edges are a star from `records[0]`) + `routes/identity.ts:160-178` (UNLINK breaks target against every member).
When the unlinked record is the star hub (or the CONFIRM anchor), survivors never had an edge between each other, so breaking the hub disconnects them all — including pairs the human never asserted anything about. Concretely reachable today: CONFIRM_LINK a third record onto the Sana pair, then UNLINK `ihn-emp-002` → **all three** become singletons, contradicting the route's own comment ("the remaining members keep their grouping… never ejects the wrong record"). Tests only cover 2-member pairs.
**Remedy:** make auto edges a pairwise clique within a match-key group (groups are tiny; O(n²) trivial), and on UNLINK re-assert survivor connectivity.

### H9 — `/cases/[id]` is completely ungated: read-only roles see every write action, and the evidence panel lies on 403 · STILL-OPEN (remnant of #181 M2, page missed)
`frontend/app/(dashboard)/cases/[id]/page.tsx` — verified: no `useAuth`/rbac import in the file. Reachable by any role via employee profile → open-case links; backend `GET /api/cases/:id` is AUTHENTICATED.
An APPROVER/VIEWER sees Send Outreach / Rerun / Assign / Escalate / Resolve (all `[CM,A]` → guaranteed 403 toasts), and `loadEvidence`'s `catch { setEvidence([]) }` renders the CM/ADMIN-gated evidence 403 as **"No evidence uploaded."** — factually wrong. This is precisely the "every role sees every option then 403s" class PR #181 claimed closed (M2); this page was missed.
**Remedy:** gate the action toolbar + evidence card behind `canManageCases`; skip the doomed fetch; distinguish "no evidence" from "not permitted".

### H10 — Studio shows author-only write controls to APPROVERs (Save Spec/Rule, Compile, AI Draft) and the measure-version packet to AUTHORs — all guaranteed 403s · STILL-OPEN (same class)
`studio/[id]/page.tsx:197-262` (tabs ungated), `SpecTab.tsx:192`, `RuleBuilderTab.tsx:331-333`, `CqlTab.tsx:175-193`, `ReleaseApprovalTab.tsx:190-196`. Backend: `PUT …/spec|cql|rule|tests` + `POST /api/measures/**` are `[AUTHOR,A]`; measure-version packet is `[APPROVER,A]`.
The Spec tab is the *default* tab — an APPROVER's first natural action (edit + Save) is a 403.
**Remedy:** thread `canAuthorMeasures` into the authoring tabs (read-only render) and gate the packet buttons by `canApproveMeasures`.

### H11 — Studio tab switch silently destroys unsaved authoring work; the ARIA arrow-key pattern makes it one keystroke · NEW
`studio/[id]/page.tsx:96-107` (arrow keys activate immediately), `:197-262` (conditional render unmounts tabs), `SpecTab.tsx:20-33` (all draft state component-local; only `cqlText` is lifted).
An author who fills the Spec form and brushes ArrowRight/ArrowLeft on the focused tab strip loses everything, with zero feedback. No dirty-check, no confirm, no `beforeunload` anywhere in Studio.
**Remedy:** lift draft state (like `cqlText`), or keep tabpanels mounted (CSS hide), or manual activation + unsaved-changes confirm. Same class: the Segment editor modal discards all edits on backdrop-click/Esc (M26).

---

## Medium findings

### M1 — Caller-controlled `triggeredBy` lets a CASE_MANAGER spoof `seed:scale` / `scheduler` runs · NEW
`routes/runs.ts:188,258` pass the body's `triggeredBy` straight through (`run-pipeline.ts:177`). `triggered_by` is load-bearing identity: SEED/SCHEDULED labeling, the scheduler's 24h debounce (`scheduler.ts:150`), scale-run detection for `aggregateScaleRun` folds (`materialize-run.ts:63,89`), and the seed CLI's idempotency check. A CM posting `{"triggeredBy":"seed:scale"}` corrupts quality snapshots (live `emp-*` ids fed through the `|`-splitting scale decoder), suppresses real seed idempotency, and mislabels the run; `"scheduler"` postpones the real nightly run by up to 24h. Elsewhere the rule is "caller-supplied actor fields are ignored" — this one isn't. **Remedy:** overwrite with the authenticated actor; reserve `seed:*`/`scheduler` for internal callers.

### M2 — APPROVER can deprecate an Active measure via `POST /:id/status`, bypassing the ADMIN-only `/deprecate` gate and its required reason · NEW
`auth/authorize.ts:73-74` (`/deprecate`=[A], `/status`=[APPROVER,A]); `measure-lifecycle.ts:23` allows `Active->Deprecated` in `transitionStatus` with no reason. **Remedy:** drop `Active->Deprecated` from `ALLOWED_TRANSITIONS` (route callers to `/deprecate`).

### M3 — `POST /:id/status` Draft→Approved skips the compile + test-fixture gates · NEW
`measure-lifecycle.ts:55-73` vs `:87-100` — readiness is enforced for Approved→Active but not Draft→Approved via `/status`, violating the documented "cannot Approve unless compile passes" invariant (activation still blocks, but the Approved state + audit trail are wrong). **Remedy:** apply `approveMeasure`'s checks in `transitionStatus`.

### M4 — Bare `POST /api/ai/draft-spec` falls through to the AUTHENTICATED fallback — CM/APPROVER can drive billed OpenAI calls · NEW
`routes/ai.ts:73-93` (bare alias) matches no POST rule (`authorize.ts:118` fallback), unlike the `[AUTHOR,A]`-gated measure-scoped form. Cost-abuse surface. **Remedy:** add `POST /api/ai/** → [AUTHOR,A]` or delete the bare alias.

### M5 — Refresh-token "rotation" never invalidates the previous token; logout is client-side only · NEW
`routes/auth.ts:89-103`, `auth/jwt.ts:89-107` — stateless HS256, no jti/revocation, old refresh JWT valid until 8h exp, survives logout and every rotation. CLAUDE.md's "token rotation" overstates the property. **Remedy:** server-side jti tracking (the CACHE KV binding exists); revoke family on reuse.

### M6 — `POST /api/admin/scheduler` (enable/disable) and `POST /api/admin/integrations/:id/sync` are unaudited state changes · NEW
`routes/admin.ts:110-113, 103-106` — flipping the switch that fires nightly audited runs leaves no ledger record of who/when. Hard-rule violation (smaller sibling of H1). **Remedy:** append `SCHEDULER_ENABLED/DISABLED` etc. events.

### M7 — Backdated RUNNING `seed:scale` runs are instantly eligible for the stuck-run sweep · NEW
`run/backfill-scale.ts:87-96` (creates RUNNING with `startedAt` backdated to `--as-of`) vs `failStuckRuns`' 30-min wall-clock threshold, fired on first `/api/runs` access (`routes/runs.ts:64-77`). Someone opening `/runs` while the owner seeds Neon flips the in-flight seed run to FAILED with a false `RUN_RECOVERED` audit; the CLI's unconditional `finalizeRun` then resurrects it; an operator re-running the CLI mid-flight double-seeds 240k rows. **Remedy:** real `startedAt` on seed runs (keep the as-of in the measurement period), exclude `seed:%` from the sweep, and terminal-status-guard `finalizeRun`.

### M8 — Run audit packet silently drops case links past 50 per measure · NEW
`audit/audit-packet.ts:102-107` — `listCases({measureId})` with no limit → store default 50. A hash-stamped audit artifact misrepresents non-compliant outcomes as caseless past 50 cases. **Remedy:** explicit high limit (campaign engine already passes 100000).

### M9 — Scheduler has no cross-process claim — deploy/reconciler overlap can double-fire the daily run · NEW
`admin/scheduler.ts:146-199` — read-then-write debounce; two containers (deploy delete+recreate racing the 15-min reconciler) both pass the check. The in-code comment claims concurrent ticks are safe; that's only true in-process. **Remedy:** DB-level claim (unique marker per cycle window).

### M10 — Compliance-cycle rollover orphans prior-period OPEN cases (the Java V022 class returns) · NEW
`run/compliance-period.ts:34-58` + `run-pipeline.ts:218` — on Jan 1/Jul 1 rollover, a still-non-compliant employee gets a NEW case under the new period while the old OPEN case is never touched again. The worklist's current-cycle default hides them, but `GET /api/cases?status=open`, campaigns (no period filter — double outreach per employee), CSV exports, and MCP `list_noncompliant` all include them. Java needed migration V022 to close ~5,019 of exactly these. **Remedy:** audited close-out (`closed_reason='CYCLE_ROLLED_OVER'`) of stale-period OPEN cases at run finish.

### M11 — Segment applicability gate also blocks case *resolution*, stranding OPEN cases · NEW (found independently by two agents)
`run-pipeline.ts:244` wraps the whole upsert — including the COMPLIANT→RESOLVE path — in `isApplicable(...)`. An employee with an OPEN case who leaves the cohort and then becomes compliant keeps the OPEN case forever (feeding worklists, campaigns, `openCases` rollups). ADR-016 documents gating *creation*; blocking *closure* is unreconciled. **Remedy:** always let the RESOLVE disposition through.

### M12 — Roster `deriveCell` masks a canonically COMPLIANT outcome as DECLINED · NEW
`compliance/roster-vocabulary.ts:29` — the refusal check runs before the COMPLIANT branch, and CQL proves `Refused` is independent of `Outcome Status` (`adult_immunization.cql:21-23` vs `:61-67`). A vaccinated-after-refusal subject (the CM success story) displays DECLINED and vanishes from `?status=COMPLIANT` filters. Display-only (not an ADR-008 write violation) but the roster is *misrepresenting*, not displaying, the authoritative bucket. Unreachable with today's seed (`withRefusal` has no production caller); reachable via E12 ingress. **Remedy:** apply DECLINED only when the canonical bucket is non-compliant.

### M13 — Duplicates worklist drops a person ACTIVE in >1 system if they have any PRIOR link · NEW
`identity/identity-model.ts:224-229` — predicate is "has no PRIOR source", not "ACTIVE in >1 tenant". A moved person with a second ACTIVE record attached via CONFIRM_LINK (reachable today on Omar) is a genuine duplicate yet vanishes from `/api/identity/duplicates`. **Remedy:** count distinct ACTIVE tenants > 1.

### M14 — Unguarded `::uuid` casts in `PgCaseEventStore`/`appendLog` — floor returns a clean miss, ceiling throws 500 · NEW
`case-event-store-postgres.ts:98,108,121`, `run-store-postgres.ts:122-125`. Every current caller happens to be shielded by a prior `getCase()` 404, but the contract diverges and the store-contract test doesn't cover these methods — the next caller passing a raw path param 500s on Neon while passing every floor test. **Remedy:** the `isUuid` early-return pattern these files already use elsewhere + contract-test coverage.

### M15 — `failStuckRuns` is SELECT-then-UPDATE (non-atomic) and `finalizeRun` has no terminal-status guard · NEW
`run-store-sqlite.ts:162-186`, `run-store-postgres.ts:198-214`. Race (a): a run crossing the threshold between the statements is failed but not returned → unaudited state change; (b) a run finalized in between is reported "recovered" → false FAILED audit; and `finalizeRun` unconditionally overwrites FAILED→COMPLETED. **Remedy:** single `UPDATE … RETURNING`; guard `finalizeRun` with `WHERE status IN ('QUEUED','RUNNING')`.

### M16 — Unbounded, ever-growing scans behind the hottest pages: `listOutcomesWithRun` with no run bound; `listRuns(100_000)` on every run completion · NEW (live-corroborated)
`outcome-store.ts:103-108` unbounded callers `roster-read-model.ts:84`, `hierarchy-rollup.ts:97`, `program-read-models.ts:144`; plus `materialize-run.ts:88` / `backfill-quality-history.ts:113` scanning the whole runs table per completion. Each daily scheduled run adds 2,100 outcome rows to every future roster/hierarchy/programs render (the 13,200 trend-history rows are already fetched then discarded in JS). This is the mechanism behind the live 5-12s latencies (H5). **Remedy:** push "latest population run per measure" into SQL (`run_id IN (…)`), exclude `seed:trend-history` in SQL like `seed:scale`, replace the 100k run scans with targeted `WHERE triggered_by=… LIMIT 1` queries.

### M17 — Audit ledger has no `occurred_at`/`event_type`/`ref_run_id` index and the CSV export pages by OFFSET (O(N²)) · NEW
`schema-pg.ts:106` (only `ref_case_id` indexed) vs `case-event-store-postgres.ts:128-171`; `export-csv.ts:183-207`. DATA_MODEL §3.12 specifies `ref_run_id_idx`; the spike schema dropped it. **Remedy (owner-gated DDL):** the three indexes + keyset pagination for the export stream.

### M18 — Evidence date rendering is host-timezone-dependent — `last_exam_date` shifts a day on positive-UTC-offset hosts · NEW
`engine/cql/cql-execution-engine.ts:37-48` (`renderDefine` round-trips offset-less CQL DateTimes through `Date.parse`→`toISOString`), consumed by `case-detail-read-model.ts:110-111`. Demonstrated: a `2025-03-10T00:00:00` exam renders as `2025-03-09T19:00:00.000Z` on a UTC+5 host → `last_exam_date: "2025-03-09"`. Outcome buckets are unaffected (day math happens inside CQL with consistent offsets); persisted *evidence* is not reproducible across environments, weakening the deterministic-rerun/audit guarantee. Production (UTC container) currently unaffected. **Remedy:** render DateTimes from their own fields, no `Date.parse` round-trip.

### M19 — Rule Builder codegen accepts degenerate numeric params and emits silently-wrong CQL that still compiles · NEW
`engine/cql/codegen/generate-cql.ts:187-193, 78-79` — `dueSoonDays > windowDays` makes COMPLIANT unreachable (`<= -35`); non-alternatives `requiredDoses: 0` makes everyone COMPLIANT with zero doses. Both compile clean, so the header's "malformed values surface as compile failures" safety claim doesn't hold for numerics, and `saveRule` persists it. An author fat-fingering the Studio Rule Builder mislabels an entire cohort with nothing flagging it. **Remedy:** validate in `generateCql` (throws already map to 400).

### M20 — Stale-fetch races (the exact bug class fixed in the merge-picker, 8c8e877) live in 5+ other fetch effects · NEW
Unguarded result application in `people/page.tsx:56-75`, `GlobalSearch.tsx:33-56` (dropdown re-opens with results for a deleted query), `compliance/page.tsx:61-94` (slow All-Systems response lands after a fast `tenant=ihn` one → wrong rows under the selected filter), `cases/page.tsx:151-199`, `programs/[measureId]/page.tsx:131-158` + `QualityOverTime:521-538` (navigating between measure pages can show measure A's data under measure B). The repo already has the correct idiom (`let active` + cleanup) in three places. **Remedy:** apply it to these six callbacks.

### M21 — RunStatusProvider polls an orphaned run id forever; the "Run running" pill sticks until localStorage is hand-cleared · NEW
`run-status-provider.tsx:106-131` — every poll error (including 404 after a demo-reset truncation) is treated as transient. **Remedy:** on 404/403, clear the interval + `ww_active_run`.

### M22 — A synchronous EMPLOYEE run completing clobbers the persisted key of an in-flight ALL_PROGRAMS run · NEW
`run-status-provider.tsx:28-39, 56-62` — `notifyComplete` removes `ww_active_run` without checking ownership; per-employee Recalculate during a long run destroys reload-durability for the big run. **Remedy:** remove only if the stored value equals the completing runId.

### M23 — Case-detail outreach template picker calls an ADMIN-only endpoint — silently empty for the CASE_MANAGER persona · NEW
`cases/[id]/page.tsx:214-223` → `GET /api/admin/outreach-templates` (`[A]`). The role that uses outreach most never sees templates and never learns why (silent catch), plus a guaranteed-403 request per case view. **Remedy:** CM-readable template read or skip for non-admins.

### M24 — ApiClient silent refresh: no single-flight and the refreshed token never propagates · NEW
`lib/api/client.ts:44-62` + `hooks.ts:9-12` — parallel 401s each fire `POST /api/auth/refresh` against a *rotating* cookie (whoever lands second can fail → hard logout mid-session), and a successful refresh updates only that client instance while localStorage/AuthProvider keep the stale token, multiplying the race. Users perceive random session drops. **Remedy:** module-level single-flight + write-back into AuthProvider.

### M25 — `/runs` "Export Run Audit Packet" rendered for all roles; endpoint is `[CM,A]` → raw "Download failed (403)" · NEW
`runs/page.tsx:912-918` vs `authorize.ts:114`. **Remedy:** gate by role (note the three packet types have three different role rules).

### M26 — SegmentEditorModal discards all edits on backdrop-click/Escape with no dirty check · NEW
`SegmentEditorModal.tsx:182` — a multi-condition rule + overrides vanish on a reflexive Esc. **Remedy:** dirty-check confirm or disable outside-click close.

---

## Low findings

- **L1 · NEW** — `GET /api/identity/people/%zz` throws `URIError` → 500, breaking the "unknown id → 404, never 500" contract (`routes/identity.ts:57,76`). Wrap `decodeURIComponent`.
- **L2 · NEW** — `authorize()` default-permits any path outside the rule table (`authorize.ts:140`); safe today (all handlers traced), but the next non-`/api` route ships unauthenticated by default. Flip the default or pin with a test.
- **L3 · STILL-OPEN (accepted demo posture)** — all five accounts share the published password (`demo-users.ts:22-32`); the "safe" public sandbox is one login away from admin. Worth a distinct password for write-capable roles.
- **L4 · NEW** — no rate limit on `/api/auth/login` / `/refresh` (PBKDF2-210k is also a modest CPU-DoS lever).
- **L5 · NEW** — stale security comment (`worker.ts:214-215`) says identity reads are all-roles; the code is stricter. Fix before someone "fixes" the code to match the comment.
- **L6 · NEW** — campaign counting: QUEUED/SIMULATED count as `sent`; an all-failed campaign reads PARTIAL_FAILURE, never FAILED (`outreach-campaign.ts:77-96`). Misleading once a real provider is wired.
- **L7 · NEW** — `dispatchOutreach` sends before writing the audit event (`case-outreach.ts:240-283`); inert with simulated adapters, inverts the event-first discipline the moment a real send is wired.
- **L8 · NEW** — Pg date filter uses session-timezone `::date` vs the floor's UTC substring (`outcome-store-postgres.ts:177-178`); use `AT TIME ZONE 'UTC'`.
- **L9 · NEW** — floor `aggregateScaleRun` decodes `subject_id` by fixed-width `substr` (breaks silently if locations exceed 99) and both adapters hardcode `LIKE 'mhn|%'` instead of `SCALE_TENANT.id` (`outcome-store-sqlite.ts:189-191`).
- **L10 · NEW** — non-atomic multi-statement writes: `recordOutcomes` Pg chunks are separate transactions; segment `setMeasures`/`setOverrides` are DELETE-then-INSERT with no transaction (a crash leaves an enabled segment with an empty rule-set, silently changing case gating); quality snapshot floor writes are per-row.
- **L11 · NEW** — module-level `sharedPool` pins the first `DATABASE_URL` for the process lifetime (`factory.ts:131-137`).
- **L12 · NEW** — `updateSegment` normalizes `rule_json` through `parseRule` on the ceiling but preserves it verbatim on the floor — a schema-growing rule field gets dropped on Neon only (`segment-store-postgres.ts:71`).
- **L13 · NEW** — MCP role incoherence: the transport admits `ROLE_MCP_CLIENT`, which every per-tool gate then denies; AUTHOR/APPROVER tool grants can never reach the transport (`authorize.ts:63-64` vs `mcp/tools.ts:462-540`).
- **L14 · NEW** — Explain-why-flagged interpolates raw `evidence_json` into the prompt with no data/instruction fencing (`ai-assist.ts:450-453`); low risk today, real prompt-injection surface once E12 feeds WebChart-derived strings. Fence + size-cap before PR-2.
- **L15 · NEW** — CMS122 "Has *Recent* HbA1c Result" has no recency filter (`cms122.cql:20-34`); a 5-year-old HbA1c reads COMPLIANT. Known SIMPLIFIED per E14 fidelity, but the define name and MEASURES.md both say "recent". Fix docs or add the window.
- **L16 · NEW** — MEASURES.md §1.4 still documents flu OVERDUE as hard-coded false; `flu_vaccine.cql:44-49` has a real Overdue branch. Doc currency.
- **L17 · NEW** — every measure returns MISSING_DATA for out-of-population subjects via the CLI/ingress (no out-of-IPP signal in `MeasureOutcome`); a patient simply not in the program reads as non-compliance on the real-data path.
- **L18 · NEW** — deprecating a runnable measure after `pnpm seed:scale` leaves its 120k mhn counts in the hierarchy tree while the overview excludes them — the two stop reconciling by exactly that measure (`hierarchy-rollup.ts:85-86` vs `:199-204`).
- **L19 · NEW** — Recharts tooltips hardcode light-theme colors → white tooltip over dark cards in dark mode (`programs/[measureId]/page.tsx:238-241, 622-626, 684-688` + `/programs` TrendChart).
- **L20 · NEW** — multi-tab: no `storage` listener for `ww_active_run`; a run started in tab A is invisible to already-open tab B (stale data until manual reload).
- **L21 · NEW** — deep-linked `/people` for non-CM roles fires a doomed 403 fetch and renders a raw error string over a skeleton instead of the access-denied card `/campaigns`/`/orders` use.
- **L22 · NEW** — person source lists keyed by `externalId` alone (`people/page.tsx:137`); E15 PR-3's real multi-tenant data makes React key collisions likely. The merge-picker already keys `${tenantId}|${externalId}`.
- **L23 · NEW (decision, not bug)** — nav hides Cases/Worklist from APPROVER/VIEWER although the backend allows read (`layout.tsx:52-53`); combined with H9 the current state is inverted (read surface hidden, deep-linked write surface exposed).
- **L24 · NEW (live)** — `GET /api/compliance/roster?panel=bogus` returns 200 and silently defaults to the immunizations panel instead of 400 (observed live this session; contrast the 400s on malformed dates/scopeLevel).
- **L25 · NEW (fresh-clone friction)** — no `frontend/.env.local`(.example) and no dev proxy: `lib/api/client.ts:3` defaults `API_BASE` to "" so a fresh clone's local frontend calls its own origin and every API call 404s. Local backend itself boots clean in ~10s (verified this session). Document/commit a `frontend/.env.local.example`.

---

## Verified solid (evidence-backed)

1. **ADR-008 holds everywhere it was hunted.** Run pipeline persists outcomes unconditionally and segments gate only the case upsert (`run-pipeline.ts:236-252`); AI surfaces return advisory text with deterministic fallbacks and per-call audits; MCP's 13 tools are genuinely read-only with airtight per-call audit including denials (`dispatch.ts:41-83`); `proposeOrders` is pure with `intent:"proposal"`; forecast/standards/quality/identity never touch `outcomes.status`. Live check: AI explain returns the guardrail disclaimer and `provider:"openai"` with case state unchanged.
2. **No SQL injection in the stores** — every interpolated identifier is a compile-time constant; all values bound; IN-lists are generated placeholders or `ANY($1)`; `patchCase` whitelists SET keys.
3. **Outcome-band boundary math matches MEASURES.md exactly for all 14 runnable measures** (audiogram ≤335/(335,365]/>365; TB ≤330; CMS125 ≤790/820; Hep B multi-alternative ACIP intervals with strict date ordering; seed targets land inside correct bands). MISSING_DATA is checked before OVERDUE so the `@1900-01-01` fallback can't surface as OVERDUE.
4. **`aggregateScaleRun` honors the bounded-read discipline on both backends** (single GROUP BY, O(providers) rows, N-independence regression-tested), and the run list/summary/MCP/CSV-summary paths all use `countOutcomesByStatus`. The gaps are the four detail paths in H4.
5. **rbac.ts mirrors authorize.ts for every capability helper** — including the one asymmetric rule (deprecate = ADMIN, correctly `isAdmin` in Studio). The frontend gaps (H9/H10/M25) are pages not *using* the helpers, not wrong helpers.
6. **Case upsert idempotency across scopes and reruns** — ON CONFLICT on the composite key, cycle-bucketed periods, rerun reuses persisted `evaluationDate`, SITE runs compute the seeded distribution over the full population before filtering; store-contract tested.
7. **Per-subject error isolation** — engine failure → MISSING_DATA with error evidence + PARTIAL_FAILURE, never an aborted run; mirrored in rerun, backfill, snapshot paths. `evaluateBatch` isolates per item with fail-fast measure validation.
8. **E16 snapshot hook is best-effort and idempotent** (after `finalizeRun`, `.catch` logs, unique-key upsert); `buildSnapshotRows` reconciles All = Σ tenants = Σ sites = Σ providers *by construction* (single `record()` fan-out). Live: 13 months of history, numerator/denominator sane at 120k scale.
9. **Auth fundamentals**: refresh tokens can't authenticate API calls and vice versa (`jwt.ts:95,104`); timing-safe signature compare; CORS exact-origin echo with production fail-fast on wildcard/localhost; actor identity always server-derived (spot-checked identity/segments/campaigns); evidence filenames sanitized both directions; VIEWER write-block enforced pre-authority (`authorize.ts:136`) — live-confirmed 403 on all 8 probed write routes.
10. **X-Total-Count survives the frontend cache by construction** (`getWithHeaders` bypasses the TTL cache; every paginated consumer uses it); cache never stores failures and every mutation busts it even on error.
11. **Live reconciliation invariant**: full-tree check of the production `/api/hierarchy/rollup` this session — **0 mismatches across every level and all 6 buckets** (All Systems = 1,682,100 = ihn 700 + twh 1,400 + mhn 1,680,000).
