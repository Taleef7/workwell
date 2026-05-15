# WorkWell Measure Studio — Sprint Index

> **Source of truth** for all post-critique implementation work. Sprint files are ordered for sequential execution. Complete each sprint before starting the next unless explicitly noted as parallelizable.

Generated: 2026-05-14 from the full expert audit of the live application, codebase, v0 prototype screenshots, vision document, and competitive landscape research.

---

## Sprint Order & Rationale

| Sprint | File | Focus | Effort | Priority |
|--------|------|--------|--------|----------|
| 0 | [SPRINT_00_critical_demo_fixes.md](SPRINT_00_critical_demo_fixes.md) | Visible production bugs that immediately undermine credibility | 1–2 days | **URGENT** |
| 1 | [SPRINT_01_run_pipeline_operational.md](SPRINT_01_run_pipeline_operational.md) | Async runs, scheduling, pagination, scoped runs | 4–5 days | High |
| 2 | [SPRINT_02_demo_data_visual_quality.md](SPRINT_02_demo_data_visual_quality.md) | Seed personas, trend charts, measure catalog richness | 2–3 days | High |
| 3 | [SPRINT_03_employee_profile_case_sla.md](SPRINT_03_employee_profile_case_sla.md) | Employee cross-program view, search, SLA tracking | 4–5 days | High |
| 4 | [SPRINT_04_security_api_quality.md](SPRINT_04_security_api_quality.md) | JWT refresh, rate limiting, OpenAPI, MIME validation | 2–3 days | Medium |
| 5 | [SPRINT_05_test_suite_ci.md](SPRINT_05_test_suite_ci.md) | Frontend tests (Vitest + RTL), Playwright E2E, CI gates | 4–5 days | Medium |
| 6 | [SPRINT_06_admin_integration_completeness.md](SPRINT_06_admin_integration_completeness.md) | Admin polish, email delivery, notification templates | 3–4 days | Medium |
| 7 | [SPRINT_07_overdelivery_features.md](SPRINT_07_overdelivery_features.md) | OSHA→CQL AI authoring, risk scoring, MAT export, mobile | 6–8 days | Differentiator |

**Total estimated effort:** 26–35 developer days

---

## How to Use These Files

Each sprint file follows this structure:

1. **Sprint Goal** — the one outcome that defines success for this sprint
2. **Prerequisites** — what must be done before starting
3. **Issues** — each identified problem/gap, with:
   - Current behavior (what's happening now, including evidence)
   - Desired behavior (exact expected outcome)
   - Root cause (why it's broken/missing)
   - Files to modify (exact paths)
   - Implementation steps (step-by-step with code)
   - Acceptance criteria (verifiable checklist)
   - Recommendations (engineering judgment calls)
4. **Definition of Done** — the sprint is complete when all items pass

---

## Critical Path

```
Sprint 0 (bugs) → Sprint 2 (data) → Sprint 1 (pipeline) → Sprint 3 (employee)
                                                         → Sprint 4 (security)
                                                         → Sprint 5 (tests)
                                  → Sprint 6 (admin)
Sprint 7 (overdelivery) — begins after Sprint 3 is complete
```

Sprint 0 is a hard prerequisite for any demo. Sprints 1, 2, 3 are the core operational improvements. Sprints 4, 5, 6 are hardening. Sprint 7 is differentiation.

---

## Conventions Used in Sprint Files

- `backend/` paths are relative to `backend/src/main/java/com/workwell/`
- `frontend/` paths are relative to `frontend/`
- Code blocks contain the actual code to write, not pseudocode
- Every issue has an **Acceptance Criteria** checklist — do not mark an issue done until all boxes are checked
- Branch naming: `fix/sprint-0-<slug>`, `feat/sprint-1-<slug>`, etc.
