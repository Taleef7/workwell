# Pass 2 — Functional & Acceptance Verification

**Fable Deep Review · 2026-07-02 · WorkWell Measure Studio**

Method: live login as all five roles against `https://twh-api-ts.os.mieweb.org`; a 17-endpoint × (anon + 5 roles) RBAC matrix; write-gate probes (11 mutating calls as forbidden roles); adversarial-input probes; timed latency measurements; data-shape and invariant verification (full-tree rollup reconciliation, MeasureReport population reconciliation); reversible writes only (campaign dry-run, AI explain — both audited/append-only); a Playwright walk of every dashboard route as admin with 30+ screenshots (`screenshots/`); a local boot of the backend (SQLite floor); and static gates (backend 840 tests green, frontend lint/test/build green). Destructive/mutating operations (real campaign send, reconcile write, manual run trigger, segment CRUD) were **not** exercised against the shared demo — verified instead via the 840-test CI suite and code review, marked accordingly.

Finding IDs reference `01-code-bug-review.md` (H/M/L) plus UX findings in `03-ui-ux-inspection.md` (UX-*).

---

## 1. RBAC verification (live)

**Matrix result: exact match with the documented gates — no bypass found in 17 × 6 = 102 probes.**

| Endpoint (GET unless noted) | anon | ADMIN | CM | AUTHOR | APPROVER | VIEWER |
|---|---|---|---|---|---|---|
| /api/measures, /api/runs, /api/cases, /api/compliance/roster, /api/hierarchy/rollup, /api/tenants, /api/quality/history, /api/immunization/forecast, /api/exports/*, /api/audit-events/export, /api/segments, /api/employees/:id/simulate | 401 | 200 | 200 | 200 | 200 | 200 |
| /api/identity/people, /api/identity/duplicates | 401 | 200 | 200 | **403** | **403** | **403** |
| /api/orders/proposals, /api/campaigns | 401 | 200 | 200 | 403 | 403 | 403 |
| /api/admin/integrations | 401 | 200 | 403 | 403 | 403 | 403 |

Write gates (all live-probed): VIEWER → **403 on all 8** attempted writes (runs/manual, segments POST/PUT/DELETE, campaigns, case outreach, identity reconcile, measures). CM → 403 on segment writes + measure create. AUTHOR → 403 on identity reconcile. The E15 PII read-gate (national ids + DOB CM/ADMIN-only) **holds live**, including for the sandbox VIEWER role. Refresh without cookie → 401.

Caveats found in code, not reachable via these probes: M2 (APPROVER can deprecate via `/status`), M3 (`/status` skips approval gates), M4 (bare `/api/ai/draft-spec` under-gated), M1 (spoofable `triggeredBy`).

## 2. Adversarial-input handling (live)

| Probe | Expected | Actual |
|---|---|---|
| quality/history `from=2026-1` · `scopeLevel=bogus` | 400 | **400 · 400** ✓ |
| hierarchy/rollup `from=garbage` | 400 | **400** ✓ |
| simulate `asOf=99-99-9999` | 400 | **400** ✓ |
| forecast without subjectId | 400 | **400** ✓ |
| unknown person / employee / case / run | 404 | **404 ×4** ✓ |
| MeasureReport on multi-measure run | 422 | **422** ✓ |
| roster `panel=bogus` | 400 | **200 (silently defaults to immunizations)** — L24 |
| identity id `%zz` (from code review) | 404 | **500 (URIError)** — L1 |

## 3. User-story / scenario matrix (32 stories)

Legend — Method: **live-API**, **live-UI** (screenshot), **CI+code** (verified by the 840-test suite + source read; not exercised against shared demo), **local** (SQLite floor boot).

| # | Persona | Scenario | Expected | Actual | Verdict / Finding |
|---|---|---|---|---|---|
| S1 | all 5 | Login with demo credentials | JWT + role claim, redirect /programs | All 5 authenticate; admin UI lands on /programs with live KPIs (`01-programs-desktop.png`) | ✅ live-API/UI |
| S2 | anonymous | Hit any /api surface | 401 | 401 on all 17 | ✅ live-API |
| S3 | VIEWER | Attempt any write | 403, nothing mutated | 403 ×8 | ✅ live-API |
| S4 | VIEWER/AUTHOR/APPROVER | Read identity PII directory | 403 | 403 | ✅ live-API |
| S5 | ADMIN | Programs overview: KPIs + per-measure cards + trends | Real counts; All-Systems = 1,682,100 | KPIs exact; trend charts render; System selector switches twh/ihn (`02-programs-system-ihn.png`) | ✅ live-UI |
| S6 | ADMIN | Hierarchy drill-down at 120k | Reconciling tree, tenant subtree, provider-leaf for mhn | Full-tree check: **0 mismatches, all 6 buckets, every level**; mhn expands region→provider (`03-hierarchy-mhn-expanded.png`) | ✅ live-API/UI — but 5–7s/hit (H5/M16); provider nodes named "Clinic 1-1" read as locations (UX) |
| S7 | ADMIN | Measure detail: trend, drivers, risk outlook | Renders from latest completed run | Renders (`04`, `05`) | ✅ live-UI |
| S8 | ADMIN | Quality-over-time card: scope + as-of month → numerator/denominator KPI | Snapshot-backed history | 13 months live (2025-07→2026-07), e.g. audiogram all-scope 93,717/113,547; scope+month switch works (`05`) | ✅ live-API/UI |
| S9 | ADMIN | Compliance roster: panels, filters, search, System/Segment selects | Grid with display vocabulary + NOT_APPLICABLE overlay | Works; overlay visible (`06`–`08`) | ✅ live-UI — but first-hit 12s (H5/M16); demo personas float to top again (**REGRESSED**, UX-1); immunization panel is a wall of "Not Applicable" for non-clinical staff (UX-2) |
| S10 | CM | Case worklist: filters, table view, pagination | Filterable, X-Total-Count paging | Works (`09`, `10`) | ✅ live-UI |
| S11 | CM | Case detail: why-flagged, evidence explorer, timeline | Structured CQL evidence visible | Renders with evidence + metadata + next-action (`11`, `12`) | ✅ live-UI — raw run UUID shown; native file input; stray `ev.tmp.txt` test upload visible (UX-3) |
| S12 | CM | AI explain-why-flagged | 2–3 grounded sentences, disclaimer, no compliance decision | Live: `provider:"openai"`, grounded text, guardrail disclaimer, case state unchanged | ✅ live-API |
| S13 | CM | Send outreach (EMAIL/SMS/PHONE) on a case | Audited simulated send, delivery state | Not exercised (mutates shared state); atomic audit dual-write + channel port verified in code/tests | ⚠️ CI+code — plus M23: CM's template picker silently empty (admin-only endpoint) |
| S14 | CM | Bulk campaign dry-run | Recipient preview, zero sends | Live: 28 recipients, sent/failed/simulated all 0, no campaign persisted | ✅ live-API |
| S15 | CM | Campaign send + history | Audited OUTREACH_CAMPAIGN_COMPLETED | History shows prior real campaign (19 SMS simulated) live; send not re-exercised | ✅ live-API (read) / CI+code (send) |
| S16 | CM | Rerun-to-verify closes case when compliant | Case → RESOLVED via CQL path | CI+code (contract-tested; `case-rerun.ts` audits) | ⚠️ CI+code |
| S17 | CM | Orders: proposals + standing-order suppression + FHIR bundle | Advisory ServiceRequests, dedupe | Live API returns proposals w/ CPT codes + dedupe keys; UI renders both sections (`20`, `21`) | ✅ live-API/UI |
| S18 | CM | People: duplicates + mobility + merged timeline | Sana = DUPLICATE; Omar = mobility, excluded from duplicates | Live: exactly that; mobility banner + system-tagged timeline (`13`–`15`) | ✅ live-API/UI |
| S19 | CM | Reconcile CONFIRM_LINK / UNLINK | Audited person_links override | Not exercised (mutates shared identity state); route + store contract-tested | ⚠️ CI+code — **H8**: UNLINK shatters 3+-member groups; M13: duplicates list drops PRIOR+2-ACTIVE people |
| S20 | any | Employee profile + compliance card + simulate scrubber | As-of re-evaluation, advisory only | Simulate 2027 date shows RECURRING aging, PERMANENT stable (`16`, `17`); API validates asOf | ✅ live-UI/API |
| S21 | ADMIN | Immunization forecast on adult_immunization case | Advisory 3-series forecast | Forecast API 200 live | ✅ live-API |
| S22 | AUTHOR | Author measure: spec, CQL (Monaco), rule builder, value sets, tests | Editable tabs, compile gate | All tabs render incl. Monaco + Standards fidelity (`23`–`28`) | ✅ live-UI (read) — but H10 (APPROVER sees author controls), H11 (tab switch loses work), M19 (codegen accepts degenerate numerics) |
| S23 | AUTHOR | Compile invalid CQL → cannot approve | Compile gate blocks | `approveMeasure` enforces compile+fixtures (CI-tested) | ⚠️ CI+code — **M3**: `/status` path bypasses the same gate |
| S24 | APPROVER | Approve → activate lifecycle | Gated transitions, audited | CI+code | ⚠️ CI+code — M2: `/status` also allows APPROVER deprecation |
| S25 | CM/ADMIN | Trigger scoped run (ALL_PROGRAMS/MEASURE/SITE/EMPLOYEE/CASE) | Async run, progress, audit | Not manually fired (shared state); **live SCHEDULED runs observed** — scheduler fired real audited ALL_PROGRAMS runs at 2,100 evaluated on 3 consecutive days | ✅ live observation + CI — H1: those runs' case transitions are unaudited |
| S26 | any | Run history: Status/Scope/Trigger filters, SEED/SCHEDULED labels | Correct derivation from triggered_by | Live `/api/runs` shows MANUAL/SCHEDULED/SEED correctly; Seed filter verified end-to-end in UI (`30`, `31`) | ✅ live-API/UI — M1: labels spoofable by any CM; UX-18: the Trigger filter offers no "Scheduled" option; UX-19: viewing a run auto-fires a billed AI insight call |
| S27 | any | Run detail outcomes grid | Bounded, paged | OK on ≤2,100-subject runs; **a 120k SEED run's detail/QRDA/MR/CSV loads all rows: 23–43s measured** | ❌ **H4** |
| S28 | CM | Exports: runs/outcomes/cases CSV + audit CSV | Documented column contracts | All four live, headers match DATA_MODEL §6 exactly; audit export streams | ✅ live-API — M17: export paging is O(N²) as ledger grows |
| S29 | CM | FHIR MeasureReport + QRDA on a completed run | Reconciling populations; 422 for multi-measure | Live: IPP 100 = DENOM 97 + DENEX 3, NUMER 78, score 0.804; 422 verified; QRDA well-formed XML | ✅ live-API |
| S30 | CM | Auditor case packet JSON + HTML | Hash-stamped packet | Live: 200 both formats (4.2KB/16.6KB, ~2s) | ✅ live-API — M8: run packets cap linked cases at 50 |
| S31 | any | Session refresh / expiry behavior | Silent refresh via HttpOnly cookie | Refresh endpoint gated (401 w/o cookie) live | ⚠️ partial — M24: parallel-401 refresh race can randomly log users out; M5: rotation doesn't revoke old tokens |
| S32 | developer | Fresh clone → local boot | Documented quickstart works | Backend: **UP in ~10s** on SQLite floor, zero external services (local). Frontend: cannot reach backend without an undocumented `.env.local` | ⚠️ **L25** |

## 4. Per-surface acceptance table

| Surface | Intended acceptance criteria | Met? | Evidence | Findings |
|---|---|---|---|---|
| Auth/RBAC | Roles gate nav + API; VIEWER read-only; PII CM/ADMIN | **Yes** (API); frontend has gaps | §1 matrix | H9, H10, M25, L23 |
| /programs | Real KPIs, reconciling, trend, tenant filter | **Yes** | S5; 01-02.png | UX: trend flat-ish "0% from last run" on several cards |
| /programs/hierarchy | All = Σ tenants … at 120k | **Yes — exact** | S6; 0-mismatch check | H5/M16 perf; H7 (RUNNING-run inclusion, latent); L18 |
| Quality-over-time (E16) | Snapshot-backed history, real evaluated | **Yes** | S8; 13 months live | — |
| /compliance roster | Grid + vocabulary + segment overlay + tenant | **Yes** | S9 | 12s first hit; UX-1 (persona float REGRESSED), UX-2; M12 (latent DECLINED mask); L24 |
| /cases + detail | Worklist, evidence, actions, timeline | **Yes** for CM/ADMIN | S10–S13 | H9 (other roles), M23, M10 (rollover orphans, latent), H2 (state clobber, latent) |
| Campaigns | Dry-run purity, gated, audited | **Yes** | S14–S15 | L6 (counting semantics) |
| /orders | Advisory proposals, suppression, FHIR | **Yes** | S17 | — |
| /people (E15) | Duplicates, mobility, merged timeline, gated reconcile | **Yes** | S18–S19 | H8, M13, L21, L22 |
| Studio authoring | Tabs, Monaco, compile gate, fidelity | **Yes** (as AUTHOR/ADMIN) | S22–S24 | H10, H11, M2, M3, M19 |
| /runs | History, filters, detail, artifacts | **Yes** except at scale | S25–S27, S29 | **H4**, M1, M7, M15 |
| Exports & standards artifacts | CSV contracts, MeasureReport, QRDA, packets | **Yes** | S28–S30 | M8, M17 |
| Admin console | Tabs, integrations, scheduler, groups | **Yes** — all 5 tabs live-verified: real scheduler state (last fire 7/2 01:03, next 7/3), integration health w/ correct simulated-HRIS distinction, populated delivery log, 3 seeded segments (150/35/61 members), live audit ledger w/ mutation filters | screenshots 33–38 | M6 (unaudited toggles), M9, UX-21 |
| MCP | 13 read-only tools, audited | Yes (code+tests; not live-exercised — needs a JWT-bearing MCP client) | code review | L13 |
| Scheduler (E13 PR-3) | Real audited daily ALL_PROGRAMS runs | **Yes — observed live** | S25 | M9, H1 |
| Local dev | Boot floor with no services | **Backend yes; frontend needs undocumented env** | S32 | L25 |

## 5. Non-functional observations (live, warm measurements)

| Endpoint | Latency | Verdict |
|---|---|---|
| /api/quality/history · /api/identity/people | 0.28–0.29s | ✅ |
| /api/cases?status=open | 0.65s | ✅ |
| /api/runs?limit=20 | 1.3s | ✅ (the #219 P0 fix holds) |
| /api/hierarchy/rollup | **5.0–7.3s every hit** | ❌ H5/M16 |
| /api/compliance/roster (per-panel first hit) | **11.8–12.5s**, ~2.4s warm | ❌ H5/M16 |
| MeasureReport / QRDA / outcomes-CSV on a 120k run | **23s / 35s / 43s** | ❌ H4 |

Resilience: malformed dates → 400 everywhere probed except L24/L1; unknown ids → 404; health endpoint public; the 60s gateway is the hard ceiling the H4/H5 paths flirt with.

## 6. What is genuinely working (evidence-backed summary)

The product loop is real end-to-end on the live stack: author→compile→approve→activate (CI-tested gates), scheduled + manual population runs over 150 live-evaluated employees folded with a 1.68M-row scale tenant, per-employee CQL evidence rendered in the UI, idempotent case management with outreach/campaign machinery (simulated), advisory orders/forecasts/AI with the ADR-008 guardrail intact everywhere it was hunted, standards artifacts (MeasureReport/QRDA/MAT/packets) that reconcile, a materialized quality-over-time source of truth with 13 months of real evaluated history, cross-system identity with human-gated reconcile, and an exact multi-tenant reconciliation invariant at 1,682,100 evaluated. RBAC is airtight at the API layer across 102 probes. The gaps that matter are concentrated in: audit-ledger completeness on the run pipeline (H1/H2), unbounded reads at 120k scale (H4/H5/M16), role-fit on two frontend surfaces (H9/H10), and latent correctness on the future real-data path (H3, M12, M19).
