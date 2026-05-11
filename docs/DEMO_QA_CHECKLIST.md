# WorkWell Measure Studio — Demo QA Checklist

**Purpose:** Manual verification checklist for the three primary user flows before any demo or post-merge confirmation pass. Run this after every significant backend or frontend change.

## Prerequisites

- Backend is running (`./gradlew bootRun` or deployed on Fly.io)
- Frontend is running (`pnpm dev` or deployed on Vercel)
- Seeded data is present (run `POST /api/runs/manual` with `ALL_PROGRAMS` if needed)

---

## Author Flow

| # | Step | Expected | Pass? |
|---|------|----------|-------|
| 1 | Log in as `author@workwell.dev` (password: `Workwell123!`) | Redirected to Programs dashboard | |
| 2 | Navigate to `/measures` | Measure list loads with at least 4 seeded measures | |
| 3 | Click a measure → go to Studio | Studio tabs visible: Spec, CQL, Value Sets, Tests, Traceability, Activation Impact | |
| 4 | Edit the Spec tab (update description) and save | Save succeeds, no error toast | |
| 5 | Click "AI Draft" on Spec tab | AI-generated draft appears with "review before saving" banner | |
| 6 | Go to CQL tab → click Compile | Compile result shows (COMPILED or error detail, never silent) | |
| 7 | Go to Value Sets tab → attach a value set | Value set linked, governance resolve-check runs | |
| 8 | Go to Tests tab → run fixtures | Test results shown; pass/fail per fixture | |
| 9 | Try to Approve/Activate the measure | Action is denied (author role; 403 response or disabled button) | |
| 10 | Check Traceability tab | Policy-to-evidence matrix rows populated, gap indicators visible | |

---

## Approver / Admin Flow

| # | Step | Expected | Pass? |
|---|------|----------|-------|
| 1 | Log in as `admin@workwell.dev` (password: `Workwell123!`) | Redirected to Programs dashboard | |
| 2 | Open Studio for a Draft measure | Activation Impact Preview tab visible | |
| 3 | Click "Preview Impact" | Dry-run outcome counts shown; no DB write occurs | |
| 4 | Go to Value Sets tab → run Resolve Check | Blockers or warnings shown for unresolved value sets | |
| 5 | Approve the measure | Status changes to `APPROVED`; audit event written | |
| 6 | Activate the measure | Status changes to `ACTIVE`; audit event written | |
| 7 | Navigate to Admin (`/admin`) | Scheduler controls and integration health visible | |
| 8 | Trigger manual sync (`POST /api/admin/integrations/mcp/sync`) | Returns 200; last_sync_at updated | |
| 9 | Export measure audit packet (from Studio → Packet) | JSON or HTML packet downloads; contains spec, CQL hash, compile result | |

---

## Case Manager Flow

| # | Step | Expected | Pass? |
|---|------|----------|-------|
| 1 | Log in as `cm@workwell.dev` (password: `Workwell123!`) | Redirected to Programs dashboard | |
| 2 | Navigate to `/runs` | Run history table loads | |
| 3 | Trigger a run: click "Run Now" or `POST /api/runs/manual` with `ALL_PROGRAMS` | Run appears in list with status `COMPLETED` or `PARTIAL_FAILURE` | |
| 4 | Open the run detail | Outcome counts per measure shown (Compliant, Overdue, etc.) | |
| 5 | Navigate to `/cases` | Worklist loads with open cases | |
| 6 | Filter cases by status `OPEN` | Filtered list returns only open cases | |
| 7 | Open a case | Case detail loads: employee info, Why Flagged, timeline, action buttons | |
| 8 | Click "Explain Why Flagged" (AI) | 2–3 sentence explanation appears, grounded in evidence | |
| 9 | Click "Send Outreach" | Outreach action recorded; timeline updated; delivery status `QUEUED` | |
| 10 | Upload evidence file (PDF or image) | Upload succeeds; file linked to case; audit event written | |
| 11 | Attempt to download evidence as viewer (wrong role) | Request denied (403) | |
| 12 | Download evidence as case manager | File downloads; `EVIDENCE_DOWNLOADED` audit event written | |
| 13 | Click "Rerun to Verify" | Re-evaluation runs; if still non-compliant, case stays open | |
| 14 | Confirm rerun result: if `COMPLIANT`, case closes | Case status changes to `RESOLVED`; closed_at set | |
| 15 | Export case audit packet | JSON or HTML packet downloads; includes actions, outreach, AI logs | |
| 16 | Export run summary CSV (`/api/exports/runs?format=csv`) | CSV downloads with correct columns | |
| 17 | Export outcomes CSV (`/api/exports/outcomes?format=csv&runId=...`) | CSV downloads with correct columns | |
| 18 | Export cases CSV (`/api/exports/cases?format=csv`) | CSV downloads with correct columns | |

---

## Security Checks

| # | Check | Expected | Pass? |
|---|-------|----------|-------|
| 1 | Access `/api/measures` with no token | 403 Forbidden | |
| 2 | Access `/api/admin/integrations` as `cm@workwell.dev` (CASE_MANAGER) | 403 Forbidden | |
| 3 | POST `/api/measures/{id}/approve` as `author@workwell.dev` (AUTHOR) | 403 Forbidden | |
| 4 | GET `/sse` (MCP) with no token | 403 Forbidden | |
| 5 | POST outreach action with `actor=spoofed@workwell.dev` query param | Audit shows logged-in user, not spoofed value | |
| 6 | POST `/api/eval` without `X-WorkWell-Internal: true` header | 404 Not Found | |
| 7 | Download evidence with wrong role (e.g., VIEWER) | 403 Forbidden | |
| 8 | POST `/api/measures/{id}/activate` as APPROVER role | 200 OK (activation succeeds) | |

---

## MCP Verification (optional — requires Claude Desktop or MCP client)

| # | Check | Expected | Pass? |
|---|-------|----------|-------|
| 1 | Connect MCP client as unauthenticated | Connection rejected | |
| 2 | Connect as `cm@workwell.dev` (CASE_MANAGER) | Tools visible: `get_employee`, `check_compliance`, `list_noncompliant`, `explain_rule` | |
| 3 | Call `list_noncompliant` | Returns non-compliant employees; audit event `MCP_TOOL_CALLED` written | |
| 4 | Verify MCP tool audit actor | Actor in audit event matches authenticated user, not a hardcoded transport identity | |

---

## Notes

- All state-changing operations must produce an `audit_events` row. If a step passes but no audit event was written, that is a bug.
- AI surfaces are assistive only. They must never return a compliance boolean or alter case/outcome status.
- Rerun-to-verify re-evaluates through the CQL engine. If the engine still returns non-compliant, the case must stay open — even if the UI looks like it might close.
