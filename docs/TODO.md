# WorkWell Studio TODO

Date: 2026-05-05
Source: SPIKE_PLAN + JOURNAL + archived PROJECT_PLAN_v1 gap review

## Current Status Summary

- Core vertical demo flow is live: run -> outcomes -> cases -> action -> rerun-to-verify -> audit.
- Current phase is stabilization plus deferred-scope completion.
- Four-measure demo depth is now seeded and runnable (Audiogram, TB Surveillance, HAZWOPER Surveillance, Flu Vaccine).
- AI Draft Spec and Explain Why Flagged surfaces are now implemented with explicit advisory-only guardrails and AI call audit events.
- The next implementation batch should stay focused on exports, MCP expansion, and notifications/admin depth.
- Video/rehearsal ownership is with human; engineering focus stays on product completeness and quality.

## Execution Checklist (Always Run)

1. Update `docs/JOURNAL.md` for the day before/after meaningful changes.
2. Keep guardrails intact:
   - AI never decides compliance.
   - Every state change writes `audit_event`.
   - Single Spring Boot app; stub auth during this sprint.
3. Run verification gates:
   - `backend\\gradlew.bat test`
   - `frontend\\pnpm lint`
   - `frontend\\pnpm build`
4. Keep docs in sync for behavior changes:
   - `docs/ARCHITECTURE.md`
   - `docs/DATA_MODEL.md`
   - `docs/MEASURES.md`
   - `docs/DECISIONS.md`
   - `docs/DEPLOY.md`
   - `README.md`

## Priority Backlog (Deferred + Out-of-Scope Completion)

### P0 - Stabilization Hardening

- [x] Retire or clearly internalize legacy S0 placeholder eval path (`/api/eval`) to reduce confusion.
- [x] Resolve documentation drift (especially `README.md`) to reflect current live architecture and features.
- [x] Add/strengthen regression tests for:
  - idempotent case upsert key behavior
  - rerun-to-verify case closure
  - audit chain completeness across run/case/action events

### P1 - Finish Ticket 3 Depth (Authoring)

- [x] Implement Value Set manager (backend model + CRUD + attach-to-measure-version flow).
- [x] Surface value set metadata in Studio (OID/identifier, name, version, attachment status).
- [x] Integrate value set resolvability into compile/validation feedback and release gates.

### P1 - Release Governance Completion

- [x] Implement Tests tab with fixture definitions and expected outcomes.
- [x] Enforce release block if fixtures fail.
- [x] Improve approval/release UX and lifecycle transition audit detail payloads.

### P2 - Execution Maturity

- [x] Add scheduled run backbone (`@Scheduled` cron + persisted run registration).
- [x] Expand run history/log visibility (status, duration, failure reasons, filtering).
- [x] Add/standardize data freshness indicators in run summaries.

### P2 - Operations Maturity

- [x] Expand worklist filters to full target set: status, priority, assignee, measure, site.
- [x] Add basic assignment/escalation flow.
- [x] Improve case timeline/evidence consistency and clarity.

### P2 - AI Surfaces (Guardrailed)

- [x] Implement AI Draft Spec flow (policy text -> structured `spec_json` suggestion -> explicit human apply).
- [x] Implement Explain Why Flagged flow grounded strictly in `evidence_json`.
- [x] Audit every AI call with prompt/output metadata and fallback states.

### P2 - MCP Expansion (Read-Only First)

- [x] Add tools: `list_measures`, `get_measure_version`, `list_runs`, `explain_outcome`.
- [x] Keep read-only posture until explicit post-D16 write-tool decision.
- [x] Ensure per-tool audit and permission boundaries.

### P3 - Notifications + Admin

- [ ] Persist simulated outreach delivery states (`queued/sent/failed`) and expose in case timeline.
- [ ] Build Admin integrations health panel (status, last sync, manual sync trigger with stubs).

### P3 - Reporting Expansion

- [ ] Add CSV exports for run summary, outcomes, and cases (audit CSV already exists).
- [ ] Standardize export column contracts and document them.

## Recommended Next Implementation Batch

1. Add CSV exports for run summary, outcomes, and cases (audit CSV already exists).
2. Persist simulated outreach delivery states (`queued/sent/failed`) and expose in case timeline.
3. Build Admin integrations health panel (status, last sync, manual sync trigger with stubs).
4. Finalize export coverage and column-contract documentation for run/outcome/case CSVs.

## Latest Verified Checkpoint

- 2026-05-05 - MCP read-tool expansion (`list_measures`, `get_measure_version`, `list_runs`, `explain_outcome`) completed with per-tool audit events and local backend verification.
