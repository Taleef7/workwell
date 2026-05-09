# Testing, CI, and Documentation Sync README

## Objective

Make WorkWell reliable as it evolves. The backend already has meaningful integration tests; now the test suite must cover the highest-risk areas: security, actor identity, MCP, rerun verification, evidence authorization, scoped runs, frontend build, and documentation drift.

## Files to inspect

Tests:

- `backend/src/test/java/com/workwell/**`

CI:

- `.github/workflows/ci.yml`

Docs:

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`
- `docs/TODO.md`
- `docs/AI_GUARDRAILS.md`
- `docs/MEASURES.md`
- MCP docs if present

## Backend test plan

### Security tests

Add tests for:

- unauthenticated `GET /api/measures` fails.
- viewer cannot call case mutation endpoints.
- author can edit measure spec but cannot approve/activate unless allowed.
- approver can approve/activate but cannot perform case-manager-only actions unless allowed.
- admin can access admin endpoints.
- `/mcp/**` requires auth and role.
- internal `/api/eval` requires internal header.

### Actor identity tests

Add tests for:

- `?actor=spoofed@workwell.dev` does not change audit actor.
- case outreach audit actor equals logged-in user.
- AI draft audit actor equals logged-in user.
- rerun verification audit actor equals logged-in user.

### Rerun-to-verify tests

Add tests for:

- rerun-to-verify does not directly insert fake `COMPLIANT`.
- if evaluation returns `OVERDUE`, case remains open.
- if evaluation returns `COMPLIANT`, case resolves.
- if verification fails, case remains open and failure is logged.
- verification creates/links run ID.
- audit events are written.

### Evidence authorization tests

Add tests for:

- unauthenticated evidence download fails.
- unauthorized role cannot download.
- case manager/admin can download.
- unknown evidence ID returns 404.
- download writes audit event.
- uploaded filename is sanitized.
- invalid upload content type/size fails if validation implemented.

### Scoped run tests

Add tests for:

- all-program run still works.
- measure-scope run executes only one measure.
- invalid scope returns 400.
- case-scope run executes one employee/measure.
- repeated scoped runs do not duplicate cases.
- failed measure run does not fabricate outcomes.

### Overdelivery feature tests

When implemented:

- traceability endpoint returns rows.
- impact preview is dry-run only.
- data readiness detects unmapped required elements.
- unresolved value set blocks activation.
- value set diff shows added/removed codes.
- audit packet export is authorized and audited.
- MCP v2 tools are authorized and audited.

## Frontend CI

Current CI should run frontend build, not just lint.

If using pnpm:

```yaml
- name: Install deps
  run: pnpm install --frozen-lockfile
- name: Lint frontend
  run: pnpm lint
- name: Build frontend
  run: pnpm build
```

If using npm:

```yaml
- name: Install deps
  run: npm ci
- name: Lint frontend
  run: npm run lint
- name: Build frontend
  run: npm run build
```

Keep package manager consistent with the lockfile.

## Optional frontend tests

If adding Playwright:

Critical case-manager flow:

1. login
2. trigger run
3. open run detail
4. open case
5. review why flagged
6. send outreach
7. upload evidence
8. rerun to verify
9. confirm audit/timeline updated

Author/approver flow:

1. login as author
2. edit measure spec
3. compile CQL
4. validate tests
5. check readiness blockers
6. login as approver/admin
7. approve/activate

## Documentation sync

Docs must describe actual behavior.

### README.md

Update supported run scopes, auth notes, MCP auth, rerun-to-verify behavior, demo mode warning, and limitations.

### ARCHITECTURE.md

Update run job model, scoped evaluation, MCP security boundary, AI guardrails, data readiness/value set governance if implemented.

### DATA_MODEL.md

Update migrations/tables: runs columns, data readiness, terminology, audit packets, outreach templates, evidence if changed.

### TODO.md

Remove stale items, add active backlog, mark limitations honestly.

### AI_GUARDRAILS.md

Ensure it states AI drafts/spec explains/summarizes only. AI does not approve, activate, close, or mark compliance.

### MCP docs

Document endpoint path, auth requirements, roles, tool list, examples, audit behavior, sensitivity/non-goals.

## Manual QA checklist doc

Create `docs/DEMO_QA_CHECKLIST.md` with:

Author flow:

- login as author
- edit spec
- AI draft
- compile CQL
- attach value set
- validate tests
- observe approval permissions

Approver/admin flow:

- review readiness
- preview impact if available
- approve/activate
- export measure packet if available

Case manager flow:

- run all programs or measure
- open run
- open case
- review why flagged
- send outreach
- upload evidence
- rerun to verify
- verify correct open/closed behavior
- export case packet if available

Security checks:

- MCP unauthenticated
- evidence download wrong role
- spoofed actor param
- activation wrong role

## Acceptance criteria

- backend build/tests run in CI.
- frontend lint and build run in CI.
- P0 security tests pass.
- rerun correctness tests pass.
- evidence auth tests pass.
- scoped run tests pass once implemented.
- docs reflect actual behavior.
- manual QA checklist exists.
