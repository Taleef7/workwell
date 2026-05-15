# Sprint 3 — Employee Profile, Cross-Program View, SLA Tracking

**Sprint Goal:** Any user can click an employee name anywhere in the application, land on a unified employee profile showing their compliance posture across all measures, and see exactly how many days remain before each open case breaches SLA — with auto-escalation when that window expires.

**Effort estimate:** 4–5 developer days  
**Priority:** High  
**Prerequisite:** Sprint 0 (branding + bug fixes) must be complete; Sprint 1 (async runs) should be complete so fresh run data flows through

---

## Issue 3.1 — Employee Profile Page Does Not Exist

### Current behavior
There is no `/employees/[externalId]` route in the frontend. Employee names appear in the cases list, outcomes table, and run detail — but clicking them does nothing or navigates to a dead link. The backend exposes `/api/employees` (list) but has no single-employee cross-program profile endpoint. This means operators cannot answer the most basic operational question — "show me everything about this one employee" — without manually filtering four different screens.

### Desired behavior
- Every employee name rendered anywhere in the dashboard is a clickable link: `<Link href={/employees/${e.externalId}}>`.
- `/employees/[externalId]` renders a full profile page with:
  1. **Header** — name, role, site, supervisor name, start date, FHIR patient ID, active/inactive badge.
  2. **Compliance summary bar** — one colored pill per measure: green (COMPLIANT), yellow (DUE_SOON), red (OVERDUE), gray (MISSING_DATA/EXCLUDED). Clicking a pill jumps to that measure's section below.
  3. **Per-measure accordion** — one panel per measure the employee is enrolled in, showing current outcome status, last run date, days until/since due, open case link (if any), last outreach sent date, and a "Rerun this measure now" button.
  4. **Timeline** — chronological merged view of all audit events for this employee across all measures (same shape as case detail timeline, but cross-measure).
  5. **Open cases list** — filtered cases table showing only this employee's open cases with SLA countdowns.

### Root cause
No backend endpoint aggregates cross-program data for a single employee. No frontend route exists. Employee identifiers are not hyperlinked.

### Files to modify / create

**Backend:**
- Create: `backend/src/main/java/com/workwell/web/EmployeeProfileController.java`
- Create: `backend/src/main/java/com/workwell/run/EmployeeProfileService.java`
- Create: `backend/src/main/java/com/workwell/web/dto/EmployeeProfileResponse.java`

**Frontend:**
- Create: `frontend/app/(dashboard)/employees/[externalId]/page.tsx`
- Create: `frontend/features/employee/components/ComplianceSummaryBar.tsx`
- Create: `frontend/features/employee/components/MeasureAccordion.tsx`
- Create: `frontend/features/employee/hooks/useEmployeeProfile.ts`
- Modify: `frontend/app/(dashboard)/cases/page.tsx` — wrap employee name in `<Link>`
- Modify: `frontend/app/(dashboard)/cases/[id]/page.tsx` — wrap employee name in `<Link>`
- Modify: `frontend/app/(dashboard)/runs/[id]/page.tsx` — wrap employee name in `<Link>`

### Implementation steps

#### Backend — new endpoint

**Step 1: Add `EmployeeProfileResponse` DTO**
```java
// backend/src/main/java/com/workwell/web/dto/EmployeeProfileResponse.java
package com.workwell.web.dto;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

public record EmployeeProfileResponse(
    UUID id,
    String externalId,
    String name,
    String role,
    String site,
    String supervisorName,
    LocalDate startDate,
    String fhirPatientId,
    boolean active,
    List<MeasureOutcomeSummary> measureOutcomes,
    List<OpenCaseSummary> openCases,
    List<AuditEventSummary> recentAuditEvents
) {
    public record MeasureOutcomeSummary(
        UUID measureVersionId,
        String measureName,
        String measureVersion,
        String outcomeStatus,   // COMPLIANT | DUE_SOON | OVERDUE | MISSING_DATA | EXCLUDED
        String lastRunDate,
        Integer daysSinceLastExam,
        Integer daysUntilDue,
        UUID openCaseId         // null if no open case
    ) {}

    public record OpenCaseSummary(
        UUID caseId,
        String measureName,
        String outcomeStatus,
        String priority,
        String assignee,
        String slaDueDate,      // ISO date string
        Integer slaRemainingDays
    ) {}

    public record AuditEventSummary(
        String eventType,
        String occurredAt,
        String actor,
        String measureName,
        String summary          // human-readable 1-line description
    ) {}
}
```

**Step 2: Add `EmployeeProfileService`**
```java
// backend/src/main/java/com/workwell/run/EmployeeProfileService.java
package com.workwell.run;

import com.workwell.web.dto.EmployeeProfileResponse;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import java.util.*;

@Service
public class EmployeeProfileService {

    private final JdbcClient jdbc;

    public EmployeeProfileService(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public EmployeeProfileResponse getProfile(String externalId) {
        // 1. Fetch employee base data
        var emp = jdbc.sql("""
            SELECT e.id, e.external_id, e.name, e.role, e.site,
                   s.name AS supervisor_name, e.start_date, e.fhir_patient_id, e.active
            FROM employees e
            LEFT JOIN employees s ON s.id = e.supervisor_id
            WHERE e.external_id = :externalId
            """)
            .param("externalId", externalId)
            .query((rs, row) -> new Object[]{rs})
            .optional()
            .orElseThrow(() -> new com.workwell.web.NotFoundException("Employee not found: " + externalId));

        // 2. Fetch latest outcome per measure
        // Returns the most recent outcome row per (employee, measure_version) pair
        var outcomes = jdbc.sql("""
            SELECT DISTINCT ON (o.measure_version_id)
                   o.measure_version_id,
                   mv.version AS measure_version,
                   m.name AS measure_name,
                   o.status AS outcome_status,
                   o.evaluated_at,
                   o.evidence_json->>'evaluatedResource' AS evidence_meta
            FROM outcomes o
            JOIN measure_versions mv ON mv.id = o.measure_version_id
            JOIN measures m ON m.id = mv.measure_id
            JOIN employees e ON e.id = o.employee_id
            WHERE e.external_id = :externalId
            ORDER BY o.measure_version_id, o.evaluated_at DESC
            """)
            .param("externalId", externalId)
            .query(Map.class)
            .list();

        // 3. Fetch open cases with SLA data
        var openCases = jdbc.sql("""
            SELECT c.id, m.name AS measure_name,
                   c.current_outcome_status, c.priority, c.assignee,
                   c.created_at, c.updated_at
            FROM cases c
            JOIN measure_versions mv ON mv.id = c.measure_version_id
            JOIN measures m ON m.id = mv.measure_id
            JOIN employees e ON e.id = c.employee_id
            WHERE e.external_id = :externalId
              AND c.status IN ('OPEN','IN_PROGRESS')
            ORDER BY c.updated_at DESC
            """)
            .param("externalId", externalId)
            .query(Map.class)
            .list();

        // 4. Fetch last 20 audit events for this employee
        var auditEvents = jdbc.sql("""
            SELECT ae.event_type, ae.occurred_at, ae.actor, m.name AS measure_name
            FROM audit_events ae
            LEFT JOIN cases c ON c.id = ae.ref_case_id
            LEFT JOIN measure_versions mv ON mv.id = ae.ref_measure_version_id
                   OR mv.id = c.measure_version_id
            LEFT JOIN measures m ON m.id = mv.measure_id
            LEFT JOIN employees emp ON emp.id = c.employee_id
            WHERE emp.external_id = :externalId
            ORDER BY ae.occurred_at DESC
            LIMIT 20
            """)
            .param("externalId", externalId)
            .query(Map.class)
            .list();

        return buildResponse(emp, outcomes, openCases, auditEvents);
    }

    // buildResponse maps raw row maps to strongly-typed DTO — implement inline
    private EmployeeProfileResponse buildResponse(Object emp, List<Map<String,Object>> outcomes,
            List<Map<String,Object>> openCases, List<Map<String,Object>> auditEvents) {
        // Map each outcome row to MeasureOutcomeSummary
        // Map each case row to OpenCaseSummary; compute slaRemainingDays from SLA policy
        // Map each audit row to AuditEventSummary with humanReadableSummary()
        // Return assembled record
        throw new UnsupportedOperationException("implement");
    }
}
```

**Step 3: Add `EmployeeProfileController`**
```java
// backend/src/main/java/com/workwell/web/EmployeeProfileController.java
package com.workwell.web;

import com.workwell.run.EmployeeProfileService;
import com.workwell.web.dto.EmployeeProfileResponse;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/employees")
public class EmployeeProfileController {

    private final EmployeeProfileService service;

    public EmployeeProfileController(EmployeeProfileService service) {
        this.service = service;
    }

    @GetMapping("/{externalId}/profile")
    public ResponseEntity<EmployeeProfileResponse> getProfile(@PathVariable String externalId) {
        return ResponseEntity.ok(service.getProfile(externalId));
    }
}
```

#### Frontend — new route and components

**Step 4: Create `useEmployeeProfile` hook**
```typescript
// frontend/features/employee/hooks/useEmployeeProfile.ts
import { useEffect, useState } from 'react';
import { useApi } from '@/lib/api/hooks';

export interface MeasureOutcomeSummary {
  measureVersionId: string;
  measureName: string;
  measureVersion: string;
  outcomeStatus: string;
  lastRunDate: string | null;
  daysSinceLastExam: number | null;
  daysUntilDue: number | null;
  openCaseId: string | null;
}

export interface OpenCaseSummary {
  caseId: string;
  measureName: string;
  outcomeStatus: string;
  priority: string;
  assignee: string | null;
  slaDueDate: string;
  slaRemainingDays: number;
}

export interface EmployeeProfile {
  id: string;
  externalId: string;
  name: string;
  role: string;
  site: string;
  supervisorName: string | null;
  startDate: string | null;
  fhirPatientId: string | null;
  active: boolean;
  measureOutcomes: MeasureOutcomeSummary[];
  openCases: OpenCaseSummary[];
  recentAuditEvents: Array<{
    eventType: string;
    occurredAt: string;
    actor: string;
    measureName: string | null;
    summary: string;
  }>;
}

export function useEmployeeProfile(externalId: string) {
  const api = useApi();
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.get<EmployeeProfile>(`/api/employees/${externalId}/profile`)
      .then(setProfile)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [externalId]);

  return { profile, loading, error };
}
```

**Step 5: Create `ComplianceSummaryBar` component**
```typescript
// frontend/features/employee/components/ComplianceSummaryBar.tsx
import { Badge } from '@/components/ui/badge';
import type { MeasureOutcomeSummary } from '../hooks/useEmployeeProfile';

const STATUS_COLORS: Record<string, string> = {
  COMPLIANT: 'bg-green-100 text-green-800 border-green-200',
  DUE_SOON: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  OVERDUE: 'bg-red-100 text-red-800 border-red-200',
  MISSING_DATA: 'bg-gray-100 text-gray-700 border-gray-200',
  EXCLUDED: 'bg-gray-50 text-gray-500 border-gray-100',
};

export function ComplianceSummaryBar({ outcomes }: { outcomes: MeasureOutcomeSummary[] }) {
  return (
    <div className="flex flex-wrap gap-2 py-3">
      {outcomes.map((o) => (
        <a key={o.measureVersionId} href={`#measure-${o.measureVersionId}`}>
          <Badge className={`border text-xs font-medium px-3 py-1 ${STATUS_COLORS[o.outcomeStatus] ?? ''}`}>
            {o.measureName} — {o.outcomeStatus.replace('_', ' ')}
          </Badge>
        </a>
      ))}
    </div>
  );
}
```

**Step 6: Create the profile page**
```typescript
// frontend/app/(dashboard)/employees/[externalId]/page.tsx
'use client';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEmployeeProfile } from '@/features/employee/hooks/useEmployeeProfile';
import { ComplianceSummaryBar } from '@/features/employee/components/ComplianceSummaryBar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';

export default function EmployeeProfilePage() {
  const { externalId } = useParams<{ externalId: string }>();
  const { profile, loading, error } = useEmployeeProfile(externalId);

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading employee profile...</div>;
  if (error || !profile) return <div className="p-8 text-sm text-red-500">Failed to load profile.</div>;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{profile.name}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {profile.role} · {profile.site}
            {profile.supervisorName ? ` · Supervisor: ${profile.supervisorName}` : ''}
          </p>
          <p className="text-xs text-gray-400 mt-1">ID: {profile.externalId}
            {profile.fhirPatientId ? ` · FHIR: ${profile.fhirPatientId}` : ''}
          </p>
        </div>
        <Badge variant={profile.active ? 'default' : 'secondary'}>
          {profile.active ? 'Active' : 'Inactive'}
        </Badge>
      </div>

      {/* Compliance summary bar */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-gray-600">Compliance Posture</CardTitle>
        </CardHeader>
        <CardContent>
          <ComplianceSummaryBar outcomes={profile.measureOutcomes} />
        </CardContent>
      </Card>

      {/* Open cases with SLA */}
      {profile.openCases.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Open Cases</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b">
                  <th className="pb-2">Measure</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2">Priority</th>
                  <th className="pb-2">Assignee</th>
                  <th className="pb-2">SLA Remaining</th>
                </tr>
              </thead>
              <tbody>
                {profile.openCases.map((c) => (
                  <tr key={c.caseId} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="py-2">
                      <Link href={`/cases/${c.caseId}`} className="text-blue-600 hover:underline">
                        {c.measureName}
                      </Link>
                    </td>
                    <td className="py-2">{c.outcomeStatus.replace('_', ' ')}</td>
                    <td className="py-2">{c.priority}</td>
                    <td className="py-2">{c.assignee ?? '—'}</td>
                    <td className={`py-2 font-medium ${c.slaRemainingDays <= 3 ? 'text-red-600' : c.slaRemainingDays <= 7 ? 'text-yellow-600' : 'text-gray-700'}`}>
                      {c.slaRemainingDays > 0 ? `${c.slaRemainingDays}d left` : 'Breached'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Per-measure outcomes accordion */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Measure Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {profile.measureOutcomes.map((o) => (
            <div key={o.measureVersionId} id={`measure-${o.measureVersionId}`} className="border rounded p-4">
              <div className="flex items-center justify-between">
                <span className="font-medium">{o.measureName} <span className="text-xs text-gray-400">v{o.measureVersion}</span></span>
                <Badge variant="outline">{o.outcomeStatus.replace('_', ' ')}</Badge>
              </div>
              <div className="mt-2 text-xs text-gray-500 flex gap-4">
                {o.lastRunDate && <span>Last run: {new Date(o.lastRunDate).toLocaleDateString()}</span>}
                {o.daysSinceLastExam != null && <span>Days since exam: {o.daysSinceLastExam}</span>}
                {o.daysUntilDue != null && <span>Days until due: {o.daysUntilDue}</span>}
                {o.openCaseId && (
                  <Link href={`/cases/${o.openCaseId}`} className="text-blue-600 hover:underline">View open case →</Link>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Audit timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {profile.recentAuditEvents.map((ev, i) => (
              <div key={i} className="flex gap-3 text-sm">
                <span className="text-xs text-gray-400 w-36 shrink-0">
                  {formatDistanceToNow(new Date(ev.occurredAt), { addSuffix: true })}
                </span>
                <span className="text-gray-600">{ev.summary}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 7: Hyperlink employee names in cases list**
In `frontend/app/(dashboard)/cases/page.tsx`, find where the employee name is rendered in the table row and wrap it:
```typescript
// Before:
<span>{c.employeeName}</span>

// After:
<Link href={`/employees/${c.employeeExternalId}`} className="text-blue-600 hover:underline font-medium">
  {c.employeeName}
</Link>
```
Apply the same pattern in `cases/[id]/page.tsx` and `runs/[id]/page.tsx`.

### Acceptance criteria
- [ ] `GET /api/employees/{externalId}/profile` returns 200 with correct cross-program data
- [ ] Employee name in cases list and case detail is a clickable link
- [ ] `/employees/[externalId]` page renders header, compliance bar, open cases, measure accordions, and timeline
- [ ] SLA countdown displays correct remaining days (see Issue 3.3 for SLA calculation)
- [ ] 404 shown gracefully when employee externalId not found

---

## Issue 3.2 — Global Search Is Non-Functional

### Current behavior
The global search bar in the top navigation renders a text input but it is not wired to any API. Typing in it does nothing. The CLAUDE.md spec says it was deliberately hidden in Sprint 0 pending implementation, but it still occupies space in the layout even when hidden via CSS. For a demo, a working search is essential to demonstrate discovery speed.

### Desired behavior
- Search bar is visible and fully functional.
- Searches employees by name, role, or external ID (partial match).
- Returns results in a dropdown with type-ahead, debounced at 300ms.
- Each result shows name, role, site, and compliance status badge (worst active outcome).
- Pressing Enter or clicking a result navigates to `/employees/[externalId]`.
- Pressing Escape closes the dropdown.
- "No results" state handled gracefully.

### Root cause
No backend search endpoint exists. Frontend search input was hidden as a placeholder.

### Files to modify / create

**Backend:**
- Modify: `backend/src/main/java/com/workwell/web/EmployeeProfileController.java` — add search endpoint

**Frontend:**
- Create: `frontend/components/GlobalSearch.tsx`
- Modify: `frontend/app/(dashboard)/layout.tsx` — replace hidden input with `<GlobalSearch />`

### Implementation steps

**Step 1: Add search endpoint to backend**
```java
// In EmployeeProfileController.java, add:
@GetMapping("/search")
public ResponseEntity<List<EmployeeSearchResult>> search(
        @RequestParam String q,
        @RequestParam(defaultValue = "10") int limit) {
    if (q.isBlank() || q.length() < 2) return ResponseEntity.ok(List.of());
    return ResponseEntity.ok(service.search(q, limit));
}
```

**Step 2: Add `search()` method to `EmployeeProfileService`**
```java
public List<EmployeeSearchResult> search(String q, int limit) {
    String pattern = "%" + q.toLowerCase() + "%";
    return jdbc.sql("""
        SELECT e.external_id, e.name, e.role, e.site,
               (
                 SELECT o.status
                 FROM outcomes o
                 WHERE o.employee_id = e.id
                 ORDER BY o.evaluated_at DESC
                 LIMIT 1
               ) AS latest_outcome
        FROM employees e
        WHERE e.active = true
          AND (LOWER(e.name) LIKE :q OR LOWER(e.external_id) LIKE :q OR LOWER(e.role) LIKE :q)
        ORDER BY e.name
        LIMIT :limit
        """)
        .param("q", pattern)
        .param("limit", limit)
        .query((rs, row) -> new EmployeeSearchResult(
            rs.getString("external_id"),
            rs.getString("name"),
            rs.getString("role"),
            rs.getString("site"),
            rs.getString("latest_outcome")
        ))
        .list();
}

public record EmployeeSearchResult(
    String externalId, String name, String role, String site, String latestOutcome
) {}
```

**Step 3: Create `GlobalSearch` component**
```typescript
// frontend/components/GlobalSearch.tsx
'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useApi } from '@/lib/api/hooks';
import { Input } from '@/components/ui/input';
import { Search } from 'lucide-react';

interface SearchResult {
  externalId: string;
  name: string;
  role: string;
  site: string;
  latestOutcome: string | null;
}

const OUTCOME_BADGE: Record<string, string> = {
  OVERDUE: 'bg-red-100 text-red-700',
  DUE_SOON: 'bg-yellow-100 text-yellow-700',
  COMPLIANT: 'bg-green-100 text-green-700',
  MISSING_DATA: 'bg-gray-100 text-gray-500',
};

export function GlobalSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const api = useApi();
  const router = useRouter();
  const timeoutRef = useRef<NodeJS.Timeout>();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (query.length < 2) { setResults([]); setOpen(false); return; }
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(async () => {
      try {
        const data = await api.get<SearchResult[]>(`/api/employees/search?q=${encodeURIComponent(query)}`);
        setResults(data);
        setOpen(true);
      } catch { setResults([]); }
    }, 300);
    return () => clearTimeout(timeoutRef.current);
  }, [query]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function navigate(externalId: string) {
    setQuery('');
    setOpen(false);
    router.push(`/employees/${externalId}`);
  }

  return (
    <div ref={containerRef} className="relative w-72">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
          placeholder="Search employees…"
          className="pl-8 h-9 text-sm"
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute top-full mt-1 w-full bg-white border rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto">
          {results.map((r) => (
            <button
              key={r.externalId}
              onClick={() => navigate(r.externalId)}
              className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center justify-between gap-2"
            >
              <div>
                <p className="text-sm font-medium">{r.name}</p>
                <p className="text-xs text-gray-400">{r.role} · {r.site}</p>
              </div>
              {r.latestOutcome && (
                <span className={`text-xs px-2 py-0.5 rounded-full ${OUTCOME_BADGE[r.latestOutcome] ?? ''}`}>
                  {r.latestOutcome.replace('_', ' ')}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {open && results.length === 0 && query.length >= 2 && (
        <div className="absolute top-full mt-1 w-full bg-white border rounded-lg shadow-lg z-50 px-3 py-4 text-sm text-gray-400 text-center">
          No employees found
        </div>
      )}
    </div>
  );
}
```

**Step 4: Wire into layout**
```typescript
// In frontend/app/(dashboard)/layout.tsx, find the header section and replace hidden search with:
import { GlobalSearch } from '@/components/GlobalSearch';

// In the header JSX:
<GlobalSearch />
```

### Acceptance criteria
- [ ] `GET /api/employees/search?q=chen` returns matching employees
- [ ] Search results appear after 300ms debounce when ≥2 characters typed
- [ ] Clicking a result navigates to `/employees/[externalId]`
- [ ] Escape key closes the dropdown
- [ ] "No results" state is shown for queries with no matches
- [ ] `pnpm lint && pnpm build` pass

---

## Issue 3.3 — Case SLA Tracking: No Due Dates or Escalation Logic

### Current behavior
Open cases have no SLA due dates. There is no concept of "this case must be resolved by X date." The `cases` table has no `sla_due_date` column. The UI shows priority (LOW/MEDIUM/HIGH/CRITICAL) but priority is set manually and never changes. There is no automated escalation — a case that has been OVERDUE for 45 days looks identical to one that was just created.

### Desired behavior
- Every case has an SLA due date computed on creation from its outcome status and site-configurable SLA policy (e.g., OVERDUE → 14 days, DUE_SOON → 30 days, MISSING_DATA → 21 days).
- SLA remaining days are shown as a countdown in the cases list (`3d`, `Breached`, etc.) with color coding:
  - > 7 days: gray
  - 3–7 days: yellow
  - ≤ 2 days: red
  - Breached (< 0): red bold "Breached"
- A scheduled job (`@Scheduled`) runs every 6 hours, finds cases where `sla_due_date < NOW()` and `status != 'RESOLVED'`, and:
  - Bumps priority one level (LOW → MEDIUM → HIGH → CRITICAL)
  - Writes an `audit_event` of type `CASE_SLA_BREACHED`
  - Sets `next_action` to "SLA breached — immediate action required"
- Cases list supports sorting by `sla_due_date ASC` (most urgent first) as a default sort option.

### Root cause
`cases` table lacks `sla_due_date` column. No SLA policy configuration exists. No scheduled escalation job.

### Files to modify / create

**Backend:**
- Create: `backend/src/main/resources/db/migration/V019__add_case_sla_due_date.sql`
- Create: `backend/src/main/java/com/workwell/caseflow/CaseSlaService.java`
- Modify: `backend/src/main/java/com/workwell/caseflow/CaseUpsertService.java` — populate `sla_due_date` on insert
- Modify: `backend/src/main/java/com/workwell/web/CaseController.java` — expose SLA fields in response

**Frontend:**
- Modify: `frontend/app/(dashboard)/cases/page.tsx` — add SLA countdown column

### Implementation steps

**Step 1: Add `sla_due_date` migration**
```sql
-- V019__add_case_sla_due_date.sql
ALTER TABLE cases ADD COLUMN IF NOT EXISTS sla_due_date TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill existing open cases: 14 days from created_at as default
UPDATE cases
SET sla_due_date = created_at + INTERVAL '14 days'
WHERE sla_due_date IS NULL AND status IN ('OPEN', 'IN_PROGRESS');

CREATE INDEX IF NOT EXISTS cases_sla_due_date_idx ON cases(sla_due_date)
  WHERE status IN ('OPEN', 'IN_PROGRESS');
```

**Step 2: SLA policy constants (inline in service)**
```java
// In CaseSlaService.java
private static final Map<String, Integer> SLA_DAYS_BY_OUTCOME = Map.of(
    "OVERDUE",       14,
    "DUE_SOON",      30,
    "MISSING_DATA",  21
);

public Instant computeSlaDueDate(String outcomeStatus, Instant createdAt) {
    int days = SLA_DAYS_BY_OUTCOME.getOrDefault(outcomeStatus, 21);
    return createdAt.plus(days, ChronoUnit.DAYS);
}
```

**Step 3: Populate SLA on case creation in `CaseUpsertService`**
```java
// When inserting a new case row, add:
Instant slaDue = slaService.computeSlaDueDate(outcomeStatus, Instant.now());

jdbc.sql("""
    INSERT INTO cases (id, employee_id, measure_version_id, evaluation_period,
                       status, priority, current_outcome_status, last_run_id,
                       sla_due_date, created_at, updated_at)
    VALUES (:id, :employeeId, :measureVersionId, :evaluationPeriod,
            :status, :priority, :outcomeStatus, :lastRunId,
            :slaDue, NOW(), NOW())
    ON CONFLICT (employee_id, measure_version_id, evaluation_period)
    DO UPDATE SET ...
    """)
    .param("slaDue", slaDue)
    ...
```

**Step 4: Create `CaseSlaService` with scheduled escalation**
```java
// backend/src/main/java/com/workwell/caseflow/CaseSlaService.java
package com.workwell.caseflow;

import com.workwell.audit.AuditEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class CaseSlaService {

    private final JdbcClient jdbc;
    private final AuditEventPublisher auditPublisher;

    private static final Map<String, Integer> SLA_DAYS = Map.of(
        "OVERDUE", 14, "DUE_SOON", 30, "MISSING_DATA", 21
    );

    private static final List<String> PRIORITY_ORDER = List.of("LOW", "MEDIUM", "HIGH", "CRITICAL");

    public CaseSlaService(JdbcClient jdbc, AuditEventPublisher auditPublisher) {
        this.jdbc = jdbc;
        this.auditPublisher = auditPublisher;
    }

    public Instant computeSlaDueDate(String outcomeStatus) {
        int days = SLA_DAYS.getOrDefault(outcomeStatus, 21);
        return Instant.now().plus(days, ChronoUnit.DAYS);
    }

    @Scheduled(cron = "0 0 */6 * * *")  // every 6 hours
    @Transactional
    public void escalateBreachedCases() {
        var breachedCases = jdbc.sql("""
            SELECT id, priority, current_outcome_status
            FROM cases
            WHERE sla_due_date < NOW()
              AND sla_breached = FALSE
              AND status IN ('OPEN', 'IN_PROGRESS')
            """)
            .query(Map.class)
            .list();

        for (var c : breachedCases) {
            UUID caseId = (UUID) c.get("id");
            String currentPriority = (String) c.get("priority");
            int idx = PRIORITY_ORDER.indexOf(currentPriority);
            String newPriority = idx < PRIORITY_ORDER.size() - 1
                ? PRIORITY_ORDER.get(idx + 1) : "CRITICAL";

            jdbc.sql("""
                UPDATE cases
                SET priority = :priority, sla_breached = TRUE,
                    next_action = 'SLA breached — immediate action required',
                    updated_at = NOW()
                WHERE id = :id
                """)
                .param("priority", newPriority)
                .param("id", caseId)
                .update();

            auditPublisher.publish("CASE_SLA_BREACHED", "case", caseId,
                Map.of("previousPriority", currentPriority, "newPriority", newPriority));
        }
    }
}
```

**Step 5: Add SLA fields to case response DTO and controller query**
```java
// In the cases list query (CaseController or CaseQueryService), add:
// sla_due_date, sla_breached to SELECT and map to response DTO
public record CaseListItem(
    UUID id,
    // ... existing fields ...
    Instant slaDueDate,
    boolean slaBreached,
    Integer slaRemainingDays  // computed: (slaDueDate - NOW()) in days, negative if breached
) {}
```

**Step 6: Add SLA countdown column to cases list UI**
```typescript
// In frontend/app/(dashboard)/cases/page.tsx, add a new column:
// After the "Priority" column header, add:
<th className="text-left pb-2 text-xs text-gray-500">SLA</th>

// In the row body:
<td className="py-2">
  {c.slaRemainingDays != null ? (
    <span className={
      c.slaBreached ? 'text-red-700 font-semibold' :
      c.slaRemainingDays <= 2 ? 'text-red-600 font-medium' :
      c.slaRemainingDays <= 7 ? 'text-yellow-600' : 'text-gray-500'
    }>
      {c.slaBreached ? 'Breached' : `${c.slaRemainingDays}d`}
    </span>
  ) : '—'}
</td>
```

### Acceptance criteria
- [ ] `V019` migration runs cleanly and existing cases get backfilled `sla_due_date`
- [ ] New cases created by `CaseUpsertService` have `sla_due_date` set on creation
- [ ] `CaseSlaService.escalateBreachedCases()` promotes priority and writes `CASE_SLA_BREACHED` audit event
- [ ] Cases list shows SLA countdown column with correct color coding
- [ ] Employee profile page (Issue 3.1) also shows `slaRemainingDays`

---

## Issue 3.4 — Personal Worklist Queue (My Cases)

### Current behavior
The `/cases` page is a global worklist that shows all open cases across all employees, all assignees. An operator who is assigned 12 cases has no way to quickly see just their own queue. They must manually filter by assignee each time and the filter resets on navigation. There is no first-person dashboard entry point.

### Desired behavior
- Add a "My Cases" tab or sub-view at `/cases?view=mine` that shows only cases assigned to the current authenticated user.
- The tab shows a compact queue card per case with: employee name (linked), measure name, SLA countdown chip, priority badge, and quick-action buttons (Mark outreach sent, Escalate).
- The My Cases count is shown in the sidebar navigation as a badge: `Cases (7)`.
- Switching between "All Cases" and "My Cases" tabs preserves other active filters (status, priority, measure).

### Root cause
No assignee-scoped view exists. URL-based filter state is not persisted between navigations.

### Files to modify / create

**Frontend:**
- Modify: `frontend/app/(dashboard)/cases/page.tsx` — add "My Cases" tab
- Modify: `frontend/app/(dashboard)/layout.tsx` — sidebar badge for case count
- Create: `frontend/features/cases/components/MyCasesQueue.tsx`

**Backend:**
- No new endpoints needed — `/api/cases?assignee={currentUser}` already works if the username is passed

### Implementation steps

**Step 1: Add "My Cases" tab toggle to cases page**
```typescript
// In cases/page.tsx, at the top of the component, add view state:
const searchParams = useSearchParams();
const router = useRouter();
const view = searchParams.get('view') ?? 'all';

// Add tab header above the filter row:
<div className="flex gap-1 border-b mb-4">
  <button
    onClick={() => router.push('/cases?view=all')}
    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
      view === 'all' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
    }`}
  >
    All Cases
  </button>
  <button
    onClick={() => router.push('/cases?view=mine')}
    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
      view === 'mine' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
    }`}
  >
    My Cases
    {myCaseCount > 0 && (
      <span className="ml-1.5 bg-blue-100 text-blue-700 text-xs rounded-full px-1.5 py-0.5">{myCaseCount}</span>
    )}
  </button>
</div>
```

**Step 2: Wire assignee filter when view=mine**
```typescript
// When building the API fetch URL:
const { user } = useAuth();
const assigneeFilter = view === 'mine' ? user?.username : assigneeParam;
const url = `/api/cases?status=${status}&assignee=${assigneeFilter ?? ''}&limit=25&offset=${offset}`;
```

**Step 3: Add sidebar badge**
```typescript
// In layout.tsx, fetch the current user's open case count:
const [myCaseCount, setMyCaseCount] = useState(0);
useEffect(() => {
  if (!user) return;
  api.get<{total: number}>(`/api/cases?assignee=${user.username}&status=open&limit=1`)
    .then(d => setMyCaseCount(d.total ?? 0))
    .catch(() => {});
}, [user]);

// In the sidebar nav item:
<NavItem href="/cases">
  Cases
  {myCaseCount > 0 && (
    <span className="ml-auto bg-red-100 text-red-700 text-xs rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center">
      {myCaseCount}
    </span>
  )}
</NavItem>
```

### Acceptance criteria
- [ ] "My Cases" tab shows only cases assigned to the current user
- [ ] Switching tabs preserves status and priority filters
- [ ] Sidebar nav shows case count badge for current user's open cases
- [ ] Badge updates correctly after navigating away and back

---

## Definition of Done — Sprint 3

- [ ] `GET /api/employees/{externalId}/profile` returns correct cross-program data for all 4 measures
- [ ] `GET /api/employees/search?q=...` works with partial match on name/role/externalId
- [ ] Employee names are hyperlinked throughout cases, case detail, and run detail pages
- [ ] `/employees/[externalId]` renders full profile with compliance bar, open cases, measure accordions, and timeline
- [ ] SLA due dates are set on case creation and backfilled for existing cases
- [ ] `CaseSlaService.escalateBreachedCases()` tested manually by advancing system clock past SLA and calling the method
- [ ] Cases list shows SLA countdown column
- [ ] My Cases tab shows only the authenticated user's cases
- [ ] Sidebar badge shows count for authenticated user
- [ ] `pnpm lint && pnpm build` pass
- [ ] `./gradlew test` passes including any new unit tests for SLA computation
- [ ] JOURNAL.md entry added

### Recommendations

**SLA policy configurability:** The SLA constants above are hardcoded. For the MVP demo this is fine — hardcoded values are defensible. Post-demo, move them to a `sla_policies` table with per-measure overrides so site managers can customize without a code deploy.

**Supervisor chain traversal:** The profile page shows a single supervisor. The real occupational health workflow often requires notifying the full supervisor chain. Add `GET /api/employees/{externalId}/supervisor-chain` as a stretch goal in Sprint 7.

**Real-time case count:** The sidebar badge polls on mount. For the demo, polling on navigation events (using `usePathname()`) is sufficient. A WebSocket or SSE push is a Sprint 7 stretch.
