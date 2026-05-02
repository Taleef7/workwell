# WorkWell Measure Studio — 16-Day Sprint Plan

**Window:** May 2 – May 17, 2026
**Goal:** Ship full MVP scope, deployed and demoable, before internship starts May 18.
**Canonical plan:** `docs/SPIKE_PLAN.md` is the active execution plan; any legacy `PROJECT_PLAN` / `PROJECT_PLAN_v1` references are obsolete and should not be used for current work.
**Author:** Taleef Tamsal

---

## North star

By end of D16 (May 17), Doug can:
- Open a public URL and use the app
- Watch a 5-min walkthrough video
- Read JOURNAL.md and see daily progress
- Read pristine docs (ARCHITECTURE, DATA_MODEL, MEASURES, DECISIONS, AI_GUARDRAILS, DEPLOY)
- See the full system run: author measure → execute → cases → actions → rerun → audit

## Scope (no cuts)

All MVP scope from the original plan ships. Nothing deferred.

- **Authoring:** Catalog + versioning, Spec tab, CQL editor + compile gate, value sets, tests tab, approval/release.
- **Execution:** Manual run orchestrator, run logs, run summary, per-employee outcomes with evidence payload, deterministic rerun.
- **Operations:** Idempotent case upsert, case detail with Why Flagged, simulated outreach action, rerun-to-verify, full audit trail.
- **4 measures seeded:** Annual Audiogram (OSHA 1910.95), HAZWOPER Surveillance (1910.120), TB Surveillance (CDC), Flu Vaccine.
- **AI:** Explain Why Flagged + Draft Spec, with guardrails (no auto-deciding compliance).
- **MCP:** Read tools — `get_employee`, `check_compliance`, `list_noncompliant`, `explain_rule`.
- **Demo polish:** ~50-employee synthetic dataset, exportable run logs, audit trail view, walkthrough video, demo script.

---

## 16-day schedule

| D | Date | Spike | Output |
|---|------|-------|--------|
| 1 | Sat May 2 | Plan + provision | SPIKE_PLAN, DEPLOY, AGENTS, CLAUDE committed; Vercel/Fly/Neon live; ADR-002 closed |
| 2 | Sun May 3 | S0 walking skeleton | Patient → CQL eval → outcome on Next.js page, deployed end-to-end |
| 3 | Mon May 4 | S1a Audiogram vertical | Authored measure, run, outcome with evidence on detail page |
| 4 | Tue May 5 | S1b polish | Why Flagged surface clean, evidence_json shape locked |
| 5 | Wed May 6 | S2a Catalog + versioning | Measures CRUD, version clone, lifecycle states |
| 6 | Thu May 7 | S2b Spec + CQL editor + compile | Spec tab fields, Monaco editor, compile gate blocks Approve |
| 7 | Fri May 8 | S3a Run pipeline | Manual run orchestrator, run logs, run summary |
| 8 | Sat May 9 | S3b Outcomes + rerun | Per-employee outcomes persisted, deterministic rerun |
| 9 | Sun May 10 | S4a Case upsert (idempotent) | Composite key tested, no duplicates on rerun |
| 10 | Mon May 11 | S4b Case detail + action + rerun-to-verify | Why Flagged, outreach action, rerun closes case, audit chain |
| 11 | Tue May 12 | S5a AI surfaces | Explain Why Flagged + Draft Spec live, fallbacks for errors |
| 12 | Wed May 13 | S5b MCP server | 4 read tools live, Claude Desktop connects |
| 13 | Thu May 14 | S6a 4 measures seeded | Catalog full, ~50 employees, all 5 outcome types covered |
| 14 | Fri May 15 | S6b UI polish + audit view + exports | Pixel-close to v0 storyboard, audit trail view, CSV exports |
| 15 | Sat May 16 | Demo prep | Walkthrough video, DEMO.md script, deploy hardened |
| 16 | Sun May 17 | Buffer | Fix what broke. No new features. Final docs pass. |

D16 buffer is non-negotiable. Something will break.

---

## Per-spike acceptance + stop conditions

### S0 — Walking skeleton (D2)

Goal: prove the stack end-to-end, deployed.

- Spring Boot on Fly serves `/api/eval` accepting Patient bundle + CQL library, returns outcome
- Next.js on Vercel calls it, shows result
- Postgres on Neon wired (empty schema OK)
- Both deploys auto-trigger from `main` push

**Stop condition:** if Fly OOMs at 512MB, pivot to Render free tier same day.

### S1 — Audiogram vertical (D3–4)

Goal: one measure, full vertical slice.

- Annual Audiogram CQL in `backend/src/main/resources/measures/audiogram.cql`
- Run against 5 synthetic patients, outcomes persisted with `evidence_json`
- `/cases/[id]` shows Why Flagged
- evidence_json shape locked (closes ADR-002)

**Stop condition:** if cqf-fhir-cr per-define evaluation surface is unusable, fall back to evaluatedResource + AI summarization. Document in JOURNAL.md.

### S2 — Catalog + Spec + CQL editor (D5–6)

Goal: Tickets 1, 2, 3.

- Measures list: name, version, status, owner, last updated, tags
- Create flow → Draft v1.0; New Version → clone to Draft v1.1
- Lifecycle: Draft → Approved → Active; Deprecated terminal
- Spec tab: name, description, policy ref, eligibility, exclusions, compliance window, role/site filters
- CQL editor (Monaco) with compile button, status (Compiled/Warnings/Errors), dependency list, value set list
- Cannot Approve unless compile passes

### S3 — Run pipeline + outcomes (D7–8)

Goal: Ticket 4.

- "Run Measures Now" triggers run over scope (program/site/measure)
- Run summary: counts per outcome type, duration, errors, data freshness
- Run logs persisted, viewable in UI
- Per-employee outcomes with evidence_json
- Rerun produces same outcomes for same data (deterministic)

### S4 — Worklist + Cases (D9–10)

Goal: Tickets 5, 6.

- **Idempotent upsert key:** `(employee_id, measure_version_id, evaluation_period)` — explicit test before code
- Worklist filters: status, priority, assignee, measure, site
- Case detail: employee + measure context, status/priority, Why Flagged, evidence timeline
- One action: simulated outreach (writes audit, updates case state)
- Rerun-to-verify: re-evaluate one employee/measure, close case if now compliant
- Audit events: run start/end, case create/update/close, outreach sent, evidence linked

### S5 — AI + MCP (D11–12)

Goal: AI surfaces + MCP server.

- "Explain Why Flagged" on case detail → Anthropic call → 2–3 sentences grounded in evidence_json
- "Draft Spec" on new measure → Anthropic call accepting policy text → fills Spec tab
- Guardrails: AI never returns compliance decision, all calls logged, fallback states for errors
- MCP server exposes `get_employee`, `check_compliance`, `list_noncompliant`, `explain_rule`
- MCP test client (Claude Desktop config) connects, calls all 4 tools

### S6 — Seed + polish + demo (D13–15)

- **D13:** 4 measures seeded, ~50 synthetic employees, deterministic outcomes covering all 5 outcome types (Compliant, Due Soon, Overdue, Missing Data, Excluded)
- **D14:** UI polish to match v0 storyboard; audit trail view; CSV exports for run summary + outcomes + cases
- **D15:** Walkthrough video (5 min); DEMO.md script; deploy hardened (no debug endpoints, env vars locked, healthchecks green)

---

## Daily rhythm

Visible progress matters as much as actual progress. Doug's May 25, 2025 feedback ("5 hours on one lousy screenshot, no short") is the reference point.

**Morning (15 min)**
- Update CLAUDE.md "Current focus" line
- Brief both agents (backend + frontend) with today's spike scope
- Open today's JOURNAL.md entry — date header + skeleton

**Throughout the day**
- Commit per ticket: `feat(measure): catalog CRUD [S2]`
- Push to GitHub every 2 hours minimum
- Review every agent PR before merge
- Update affected docs in the same PR (never "later")

**End of day (30–45 min)**
- Finalize JOURNAL.md: goals set, what shipped, what surprised, plan for tomorrow
- Update affected docs (ARCHITECTURE, DATA_MODEL, MEASURES, DECISIONS) if structure changed
- Record YouTube short if UI changed visibly (every 2nd day minimum)

**Rule:** doc PR ships with code PR. Always.

---

## Hard risks (pre-flagged with mitigations)

### 1. Spring Boot on Fly 256MB will OOM
Budget $2/mo for 512MB tier. Tune `-Xmx384m -Xss256k`. Test deploy on D2, not D15. Fallback: Render free tier (cold-start tradeoff).

### 2. CQL has weird edge cases
Timezone math on compliance windows, value set resolution failures, FHIR helper version mismatches. Budget half of D8 for "CQL got weird." Lean on `CQF_FHIR_CR_REFERENCE.md` and the spike repo's SPIKE_NOTES.md for known fixes.

### 3. Idempotent case upsert is subtle
If rerun creates duplicate cases, demo is dead. Write upsert test BEFORE upsert code on D9. Composite key on `(employee_id, measure_version_id, evaluation_period)`. Test: rerun creates 0 new cases for unchanged data.

### 4. Anthropic API rate limits + cost
Hard $20 cap on API spend. Cache Explain Why Flagged by `(case_id, measure_version_id)`. Cache Draft Spec by policy text hash. Both calls retry once on 429, fail gracefully on 2nd. Surface "AI temporarily unavailable" in UI with rule-based fallback text.

### 5. Two agents racing same files
Strict ownership: backend agent owns `backend/`, frontend agent owns `frontend/`. Schema migrations are mine, never delegated. One feature branch per spike, merge after review. No auto-merge.

### 6. Vercel + Fly env var drift
Single `.env.example` at repo root lists all required vars. CI checks both deploys have them. DEPLOY.md is the single source of truth for what lives where.

### 7. AI auto-deciding compliance (correctness risk)
If AI ever returns a compliance boolean and that propagates, defensibility dies. AI calls return text only. CQL engine is sole source of truth. Audit log records every AI call (prompt + output). Documented in AI_GUARDRAILS.md.

### 8. MCP server complexity eating D12
Read tools only. No write tools. If D12 slips, MCP gets D16 buffer time. Don't sacrifice S6 polish for MCP depth.

### 9. UI polish is bottomless
Every hour of polish costs an hour of buffer. D14 is timeboxed. After D14 EOD, no UI changes except bug fixes. v0 screenshots are the ceiling.

### 10. Demo dataset doesn't cover all outcome types
If seeded data doesn't produce a Missing Data case, demo can't show Missing Data handling. D13 seed data must produce ≥1 case of each outcome type per measure. Verify before D14 starts.

### 11. Lock-step dependency: S2 blocks S3
Cannot run measures (S3) without measure_version table populated (S2). If S2 slips a day, S3 starts a day late. Don't try to parallelize them.

### 12. Vercel build cache breaking on schema change
After any backend type change, frontend types may need regeneration. If using OpenAPI codegen, run before every Vercel deploy. Document in DEPLOY.md.

---

## Operating rules

- **Lock the stack on D5.** No new dependencies after May 6.
- **One scope decision per day, max.** Don't revisit locked decisions.
- **Two agents in parallel, me reviewing.** Don't spawn a third — review bandwidth is the bottleneck.
- **Tests only where correctness-critical.** Idempotency + audit invariants get real tests. Rest is smoke-only.
- **Commit hygiene.** Conventional commits, spike tag in message, GitHub issue per spike, PR references issue.
- **No bypassing the audit log.** Every state change writes `audit_event`. Non-negotiable.
- **No silent scope changes.** If a spike's stop condition triggers, document fallback in JOURNAL.md and update SPIKE_PLAN.md if downstream affected.

---

## Rollback rules

When a stop condition triggers:

1. Stop work on the spike
2. Write what failed in JOURNAL.md (facts, not blame)
3. Pick the fallback path documented in spike's "Stop condition"
4. Update SPIKE_PLAN.md if downstream spikes are affected
5. Notify Doug if fallback changes the demo story

Never silently change scope.

---

## Definition of done — overall (D16 EOD)

- All 4 measures seeded, deterministic outcomes
- All 5 outcome types represented in demo data
- Idempotent case upsert tested
- Audit trail complete (run, case lifecycle, action, AI call)
- AI surfaces live with guardrails enforced
- MCP server with 4 read tools, verified by Claude Desktop
- Live demo URL on Vercel + Fly
- Walkthrough video posted (YouTube short or unlisted full)
- DEMO.md script committed
- JOURNAL.md has 16 entries, one per day
- All docs current: ARCHITECTURE, DATA_MODEL, MEASURES, DECISIONS, AI_GUARDRAILS, README, DEPLOY, SPIKE_PLAN, AGENTS, CLAUDE
- `.env.example` matches deployed env exactly

## References

- v0 storyboard: https://v0-work-well-measure-studio.vercel.app/
- Spike repo: `../workwell-spike-cqf/` (cqf-fhir-cr de-risk, completed)
- @docs/CQF_FHIR_CR_REFERENCE.md
- @docs/MEASURES.md
- @docs/ARCHITECTURE.md
- @docs/DATA_MODEL.md
- @docs/AI_GUARDRAILS.md
- @docs/DECISIONS.md
- @docs/DEPLOY.md
- @docs/JOURNAL.md
- @CLAUDE.md
- @AGENTS.md