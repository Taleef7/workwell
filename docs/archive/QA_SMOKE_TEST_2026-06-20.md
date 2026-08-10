# WorkWell Measure Studio — End-to-End QA Smoke Test & Critique

**Date:** 2026-06-20
**Tester:** Adversarial QA pass (automated + manual)
**Target:** Live stack — `https://twh.os.mieweb.org` (frontend) + `https://twh-api-ts.os.mieweb.org` (API)
**Build reported by API:** `{"api":"v1","stack":"typescript","build":"phase1-spike"}`
**Accounts exercised (all share `Workwell123!`):** `admin@`, `author@`, `approver@`, `cm@workwell.dev`

---

## 0. Verdict

**This is a real, working, API-backed application — not a Potemkin demo.** The overwhelming majority of promised functionality is genuinely implemented and live. Backend typecheck passes, **520/520 active tests pass** (1 documented Postgres-contract self-skip), frontend lint is clean, and `npm run build` succeeds. Auth/RBAC is correctly enforced server-side, AI is provably isolated from compliance decisions, MCP is provably read-only, and the audit trail is live end-to-end (my own test API calls appeared in the case timeline within seconds).

The defects found are **polish, data-coverage, documentation-integrity, accessibility, and consistency** issues — not structural failures. None are data-loss or security-critical. The single most demo-damaging item is cosmetic-but-prominent: the flagship new measure renders **0% / empty** on the main dashboard.

| Dimension | Grade | One-liner |
|---|---|---|
| Core functionality | A− | Nearly everything works; deep, coherent feature set |
| Correctness / data integrity | B+ | A few wrong labels & contradictory evidence; CQL authority intact |
| Security / RBAC (server) | A | Server-side gates correct across all roles |
| RBAC (client surfacing) | B | Campaigns leaks to roles that get 403'd silently |
| Docs ↔ reality integrity | B− | Several "it's wired" claims are actually stubbed/absent |
| UI/UX polish | B | Clean & professional; mobile + confirmation gaps |
| Accessibility (WCAG/508) | C+ | Systemic, repeatable debt — the biggest real gap |
| Test/build health | A | Green across the board |

---

## 1. Methodology & Coverage

Three parallel code-audit agents (backend API surface, frontend features, AI/MCP/tests-build) + hands-on live testing:

- **Live API sweep** across all 4 roles: RBAC matrix (reads, admin, campaigns, orders, write-paths), all read surfaces, all 4 CSV exports, MeasureReport (summary/individual/bundle), QRDA, auditor packets, CQL compile gate (valid + invalid), campaign dry-run, AI explain, immunization forecast, order proposals, login/refresh-cookie.
- **Live UI (Playwright)**: login/logout, programs overview, cases worklist + filters, full case detail (all actions, evidence explorer, audit timeline), author-role nav + gating, mobile/responsive, console-error capture.
- **Static verification**: backend `pnpm typecheck` + `pnpm test`; frontend `npm run lint` + `npm run build`; targeted source reads to root-cause UI findings.

What I deliberately did **not** do (outward-facing changes to the live demo, per change-safety norms): trigger real population runs, send real/simulated outreach at scale, create/activate measures, or mutate schema. Testing used reads + advisory/dry-run paths. (Footprint left: one AI-explain audit event from `cm@`, and dry-run previews — no sends.)

---

## 2. What's Genuinely Working (verified live)

- **Auth**: login returns JWT (15-min access) + `refresh_token` cookie (`HttpOnly; SameSite=None; Secure; Path=/api/auth; Max-Age=28800`) — correct split-origin prod config. Logout clears session. Wrong password rejected.
- **RBAC (server)**: `/api/admin/**` → ADMIN only; `/api/campaigns/**` & `/api/orders/**` → CM/ADMIN; authoring writes → AUTHOR/ADMIN; lifecycle → APPROVER/ADMIN; reads → any authenticated. Verified 403/200 per role.
- **Programs overview**: live KPIs (1000 evaluations, 77.8% compliance, 192 open cases), per-measure cards with buckets, drivers, trend.
- **Cases worklist**: "25 of 192" with real `X-Total-Count` pagination, status/measure/priority/assignee/site filters + search, bulk select, All/My tabs, CSV exports.
- **Case detail**: full action set (outreach template + EMAIL/SMS/PHONE channel, preview/send, assign, escalate, rerun-to-verify, mark-resolved, schedule-appointment, delivery-state), **CQL code-evidence explorer**, structured `why_flagged`, evidence upload/download, **live audit timeline**.
- **AI Explain**: real OpenAI (`provider:"openai"`, `fallbackUsed:false`), grounded + advisory disclaimer; deterministic fallback path exists.
- **CQL compile gate**: valid → `ok:true` + ELM; invalid → `ok:false` + structured `CqlToElmError` (line/char). Real translator.
- **Runs**: detail, logs, outcomes, **FHIR MeasureReport** (summary/bundle, correctly 422s on multi-measure runs), **QRDA XML**, auditor packets.
- **Campaigns dry-run**: returns recipient preview (status `PREVIEW`, 0 sends).
- **Immunization forecast** (3 ACIP series), **order proposals** (170 proposed / 5 suppressed, real CPT codes) — both advisory, CQL stays authoritative.
- **Hierarchy rollup**, employee profiles, value-sets, traceability, MAT export, MCP (13 read-only tools).
- **Tests/build**: backend 520/520 pass + 1 skip; typecheck clean; frontend lint clean; build succeeds.

---

## 3. Findings by Severity

### HIGH

**H1 — Flagship measure renders empty on the main dashboard.**
`Adult Immunization Status (Td/Tdap)` (E6, "verified live 2026-06-19") shows **0.0% / Compliant 0 / Due Soon 0 / Overdue 0 / Missing Data 0 / Excluded 0 / Open Worklist (0)** on `/programs`, while all 10 other runnable measures show ~100 evaluations. Root cause: the last `ALL_PROGRAMS` run (6/17, 1000 = 10×100) **predates the E6 merge (6/19)**; only single-measure Audiogram runs have happened since, so `adult_immunization` has **never been in a population run**. There are consequently **zero adult-immunization cases**, so the advisory immunization-forecast *panel* (its headline UX) cannot be exercised through a case at all.
*Remedy:* trigger one `ALL_PROGRAMS` run (or a `MEASURE` run for `adult_immunization`). **Verify** the ALL_PROGRAMS scope actually enumerates this measure (i.e., that 0% is "never run," not "can't run"). I left this for you because it mutates the live demo.

**H2 — "SendGrid wiring exists in the code" is false for `backend-ts`.**
DEPLOY.md/CLAUDE.md state SendGrid email wiring exists and is toggled by `WORKWELL_EMAIL_PROVIDER` / `WORKWELL_EMAIL_SENDGRID_API_KEY`. In `backend-ts`, `case/email-service.ts` ships **only** `simulatedEmailService`; there is no provider switch, no API-key handling, no SendGrid client (grep `sendgrid` → comments only). Those env vars are inert no-ops here. Real email cannot be enabled without new code. (The code was Java-only and not ported.) This is a **doc-integrity** risk: an operator following the docs would believe email is one env var away when it is not.

### MEDIUM

**M1 — Wrong next-action label for 7 of 11 measures.** `case-logic.ts:29-51` (`nextActionFor`) maps only TB/HAZWOPER/Flu and **defaults everything else to "audiogram"**. So a Diabetes/CMS122 overdue case shows *"Escalate **audiogram** follow-up immediately."* Affects diabetes, hypertension, cholesterol, BMI, CMS125, CMS122, adult_immunization. Demo-visible. Trivial fix (use measure name / per-measure label map).

**M2 — Campaigns RBAC leaks to roles that can't use it.** `/campaigns` is in the sidebar for AUTHOR/APPROVER and the launcher UI renders fully, but `GET /api/campaigns` returns **403** (silent console error, no user-facing message). Admin route shows a proper "Admin access required" gate — Campaigns should do the same (gate the page + surface 403). Inconsistent client RBAC.

**M3 — Admin "Outreach Delivery Log" is permanently empty.** `GET /api/admin/outreach/delivery-log` is hardcoded `return json([])` (`admin.ts:271`). DEPLOY.md/DATA_MODEL.md describe it as populated with `SIMULATED` rows; it never is. (`/api/admin/waivers` similarly returns `[]`.)

**M4 — Admin integration health & data mappings are static, not live.** `listIntegrations()` returns canned status; the "scheduled 15-min FHIR/MCP/AI/HRIS health refresh" described in ARCHITECTURE §3 was not ported. The "Sync" action is a no-op toggle. Misleading on an ops/admin screen.

**M5 — Contradictory CQL evidence on CMS122.** Case evidence shows "Most Recent HbA1c Observation: **not found**" and "Most Recent HbA1c Value: **not found**", yet "Has Recent HbA1c Result: **✓ true**" and "HbA1c Poor Control: **✓ true**" simultaneously. For a value-driven measure this is internally inconsistent and confusing to a clinician reviewing "why flagged."

**M6 — Mobile header actions overlap/clip.** At 390px on `/programs`, "Run All Measures Now" overlaps "View hierarchy" and its label is cut off. Header action bar doesn't reflow. (KPI cards otherwise stack well; hamburger nav works.)

**M7 — `/sandbox` auto-logs-in as `cm@workwell.dev` in any environment.** It's in `PUBLIC_ROUTES` and auto-establishes a Case-Manager session on mount, **not gated by `NEXT_PUBLIC_DEMO_MODE`** (unlike demo-reset and the login prefill). Consistent with the documented public-demo posture, but on any non-demo deploy it would silently grant CM access. Gate it behind the demo flag. (Note: the prod login page also exposes "Fill demo credentials" + a "Demo: admin@workwell.dev" hint + sandbox links — which sits oddly against the documented claim that `NEXT_PUBLIC_DEMO_MODE=true` *fails* the production build. Worth reconciling whether prod is actually built in demo mode.)

**M8 — Inconsistent confirmation on destructive/bulk actions.** Present: Run All, case escalate, studio approve/activate/deprecate, scheduler-disable, demo-reset. **Missing**: `/cases` **bulk escalate** (loops many cases, highest risk), **campaign send**, `/programs/[measureId]` **Run This Measure**, `/runs` rerun & manual run. The asymmetry (Run All confirms, Run This Measure doesn't) is the clearest tell.

**M9 — "Measures in this Program" table is a placeholder.** `/programs/[measureId]` always renders a single hardcoded row from the current program; the plural label promises a list that isn't fed by any endpoint.

**M10 — QRDA III is a self-described stub** (`qrda3-export.ts`: well-formed CDA but **not IG-validated**), yet listed as a headline export in README/ARCHITECTURE without the caveat at the surface. (MeasureReport, by contrast, reconciles faithfully.)

### LOW

- **L1 — Stale "phase1-spike" markers in prod.** `/actuator/health` → `phase:"1-spike"`; `/api/version` → `build:"phase1-spike"`. ARCHITECTURE §9 promises `build:"<impl-version-or-unknown>"`; it never reflects the image SHA. Misleading post-#109.
- **L2 — Invalid run scope returns 501, not 400.** `POST /api/runs/manual {scopeType:"BOGUS"}` falls through to the worker's catch-all `501 not_implemented` instead of a validation `400`.
- **L3 — Synthetic immunization-forecast data is stale.** INFLUENZA shows `OVERDUE` with `nextDueDate: 2022-09-25` (last dose 2021). Fine as synthetic, but reads as broken in a demo.
- **L4 — AI guardrails doc undercounts surfaces.** AI_GUARDRAILS §2 documents 3 surfaces; code ships **5** (adds `draftCql`, `generateTestFixtures`) — both guarded/audited, but the guardrail baseline is incomplete.
- **L5 — Primary AI model id `gpt-5.4-nano` is non-standard.** Live calls succeed (OpenAI answers in prod), but verify the intended model id; an invalid primary would silently fall to `gpt-4o-mini` then deterministic text.
- **L6 — Nav ↔ docs drift.** `/worklist` (prominent sidebar item) is a thin 2-link hub over `/cases` and is undocumented; `/studio` is a redirect to `/measures`; `/studio/elm` (real ELM explorer) and `/programs/hierarchy` (documented) are **not in the sidebar** (URL/in-page only). Worklist badge (31 = current-cycle gap count) vs 192 open cases is by-design but unexplained.
- **L7 — Store-backed value-set expansion is dormant.** `StoreValueSetResolver`/`buildCodeService` exist + tested but the engine is constructed with **no resolver** in every HTTP path — only the inline-code path runs. VSAC adapter doesn't exist (as documented).
- **L8 — Minor build warnings.** Frontend lint: 1 warning (`import/no-anonymous-default-export` in a test mock); build: non-fatal `Unknown at rule: @import` (Google Font in `@mieweb/ui`).

---

## 4. Accessibility (systemic — rate as MED overall)

For an enterprise health-compliance product, WCAG/Section-508 conformance is an expectation, and this is the largest real debt. Patterns repeat on nearly every route:

- **Tables lack `scope`/header semantics** — `/programs/[measureId]`, `/programs/hierarchy`, `/runs` outcomes, `/employees/[id]`, multiple studio panels.
- **Clickable non-buttons without keyboard support** — `/runs` clickable `<tr>` (onClick, no role/Enter/Space), ElmExplorer AST `<div>`s. (`/campaigns` rows do it correctly with `role="button"` + key handlers — use as the reference.)
- **Color/emoji-only status** — ✅/❌/⚠️ in activation checklist; status/priority badges by color alone in cases/admin/employees.
- **Unlabeled inputs** — `/measures` search + create form, SpecTab, TestsTab, ElmExplorer textarea, and the **evidence file input** (invisible to AT).
- **Studio tabs aren't an ARIA tab pattern** (no `role=tablist/tab/tabpanel`, no `aria-selected`).
- **No `aria-live`** on async status regions (run-status pulse, AI spinner, active-run timer); **no focus management** after login/modal/run.
- **Index-as-key** in `/employees/[id]` recent-activity list (reorder bug risk).
- **Charts** (recharts) have no accessible name / data-table alternative.

---

## 5. User-Story Test Matrix

| # | Persona | Scenario | Result | Finding |
|---|---|---|---|---|
| US-1 | Admin | Log in, view Programs overview | ✅ Pass | H1 (adult_immunization empty) |
| US-2 | Any | Wrong password rejected | ✅ Pass | — |
| US-3 | Admin | Logout → login as Author | ✅ Pass | — |
| US-4 | Author | Sees authoring nav, **not** Admin | ✅ Pass | — |
| US-5 | Author | Opens `/admin` | ✅ Gated ("Admin access required") | — |
| US-6 | Author | Opens `/campaigns` | ⚠️ Renders launcher, silent 403 on load | M2 |
| US-7 | CM | Browse worklist, filter, paginate, export CSV | ✅ Pass | — |
| US-8 | CM | Open case detail, view CQL evidence explorer | ✅ Pass | M5 (CMS122 contradiction) |
| US-9 | CM | AI "Explain Why Flagged" | ✅ Pass (real OpenAI + disclaimer) | — |
| US-10 | CM | Read "Next action" guidance | ⚠️ Wrong label ("audiogram") | M1 |
| US-11 | CM | Upload/download evidence, see audit timeline | ✅ Pass (live audit) | — |
| US-12 | CM | Campaign **dry-run** preview | ✅ Pass (0 sends) | M8 (send has no confirm) |
| US-13 | Author/Admin | CQL compile gate (valid + invalid) | ✅ Pass (structured errors) | — |
| US-14 | CM | Manual run with bad scope | ⚠️ 501 instead of 400 | L2 |
| US-15 | Author | Create measure (empty body) | ✅ 400 (validation) | — |
| US-16 | CM | Run measures (write) | ✅ 403 for author/approver | — |
| US-17 | Admin | Run/Case/Audit CSV + MeasureReport + QRDA | ✅ Pass | M10 (QRDA stub) |
| US-18 | Admin | MeasureReport on multi-measure run | ✅ 422 (correctly rejected) | — |
| US-19 | Any | Immunization forecast API | ✅ Pass | L3 (stale synthetic dates) |
| US-20 | CM | Order proposals (domain + fhir) | ✅ Pass (170/5) | — |
| US-21 | Admin | Hierarchy drill-down | ✅ Pass | L6 (not in nav) |
| US-22 | Admin | Admin: integrations / delivery-log | ⚠️ Static / empty | M3, M4 |
| US-23 | Any | Mobile (390px) programs | ⚠️ Header buttons overlap | M6 |
| US-24 | Anon | `/sandbox` public access | ⚠️ Auto-CM-login, not env-gated | M7 |
| US-25 | Anon | Unauthenticated `/api/cases` | ✅ 401 | — |

---

## 6. What More Should Be Done (for an app of this level)

**Productionization (the documented "drop-ins"):**
1. **Managed object storage for evidence** — currently ephemeral in-container `fs` BUCKET; uploads vanish on container recreate (the self-heal reconciler recreates containers).
2. **Real persistence** for campaigns (`PgCampaignStore`), outreach delivery log, and submitted orders — currently audit-event-backed/empty/read-only.
3. **Real email/SMS** — implement (or honestly re-document) the SendGrid/DataChaser paths (see H2); today both are simulated/stub.
4. **Real value-set expansion (VSAC)** — wire `StoreValueSetResolver` into the engine and add a VSAC adapter; today only inline-code runs and the resolver is dormant (L7).
5. **Real integration health** — replace static admin integrations with live probes + the scheduled refresh (M4).

**Quality engineering:**
6. **Run the `e2e/` Playwright suite in CI** as a gate (there's a directory; confirm it executes and covers the flows above).
7. **Accessibility/508 conformance pass** (§4) — likely the highest-leverage quality investment for a health product.
8. **User-facing error surfacing** — replace silent console 403/500s with toasts/inline messages (M2 is the canonical example).
9. **Consistent destructive-action confirmation + focus management** (M8, §4).

**Correctness & data hygiene:**
10. Fix the "audiogram" label map (M1), CMS122 evidence contradiction (M5), stale forecast dates (L3), and ensure `adult_immunization` participates in population runs (H1).
11. Wire real build/version metadata (drop "phase1-spike", emit the image SHA) (L1).

**Polish / docs:**
12. Reconcile nav vs docs (`/worklist`, `/studio`, `/studio/elm`, `/programs/hierarchy`) (L6); relabel/replace the placeholder "Measures in this Program" table (M9); demo-gate `/sandbox` + login prefill (M7); update AI_GUARDRAILS to list all 5 AI surfaces (L4).

---

## 7. Prioritized Fix List

1. **H1** — get `adult_immunization` into a population run; verify ALL_PROGRAMS includes it (demo blocker).
2. **M1** — fix `nextActionFor` label map (7/11 measures show wrong guidance).
3. **M2** — gate `/campaigns` page by role + surface 403s (RBAC UX leak).
4. **H2 / M3 / M4** — reconcile docs vs reality for SendGrid, delivery-log, integration health (integrity).
5. **M6 / M8** — mobile header reflow + consistent destructive-action confirmation.
6. **§4** — start the accessibility remediation (tables `scope`, button semantics, labels, ARIA tabs).
7. **M5 / L3** — data-quality cleanup (CMS122 evidence, forecast dates).
8. **M7 / L1 / L6 / L4** — demo-gating, build metadata, nav/docs drift, guardrail doc.

*No source files were modified during this audit. No real outreach was sent; no measures/runs were created on the live stack.*
