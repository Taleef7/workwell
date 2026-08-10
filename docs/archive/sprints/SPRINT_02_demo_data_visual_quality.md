# Sprint 2 — Demo Data & Visual Quality

> **For agentic workers:** Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to implement task-by-task.

**Goal:** Make the live demo feel like a real, lived-in product by replacing system-generated placeholder data with realistic named personas, enriching the measure catalog to match the v0 prototype, and making the trend charts interpretable with proper axes and tooltips.

**Branch:** `feat/sprint-2-demo-data-visual`

**Prerequisites:** Sprint 0 complete. Sprint 1 async runs preferred (scheduled run history improves trend data).

**Estimated effort:** 2–3 days

---

## Issue 2.1 — All Measures Are Owned by "WorkWell Studio" System Actor

### Current Behavior
Every measure in the catalog shows `Owner: WorkWell Studio` because they are seeded by a system migration with a hardcoded system actor. The v0 prototype showed named owners: J. Chen, M. Patel, K. Williams. The current state makes the catalog look auto-generated, not authored by a real team.

**Evidence:** Measures page screenshot shows all 5 measures with "WorkWell Studio" as Owner and identical timestamps.

### Desired Behavior
Measures show named authors matching realistic OH team personas:
- Audiogram → J. Chen (Industrial Hygienist)
- HAZWOPER Surveillance → M. Patel (EHS Manager)
- TB Surveillance → K. Williams (Infection Control Nurse)
- Flu Vaccine → K. Williams (Infection Control Nurse)

### Root Cause
Flyway seed migrations insert measures with a hardcoded `'system'` actor. The `owner` field in the `measures` table is a plain text field — it just needs to be updated.

### Files to Modify
- `backend/src/main/resources/db/migration/` — add new migration to update owner names
- Do **not** modify existing migration files (V001–V014 are immutable once applied)

### Implementation Steps

**Step 1: Create migration V015 to update measure owners**
```sql
-- V015__seed_measure_owners_and_tags.sql

-- Update measure owners to realistic personas
UPDATE measures SET owner = 'J. Chen'
WHERE name IN ('Audiogram', 'AnnualAudiogramCompleted');

UPDATE measures SET owner = 'M. Patel'
WHERE name = 'HAZWOPER Surveillance';

UPDATE measures SET owner = 'K. Williams'
WHERE name IN ('TB Surveillance', 'Flu Vaccine');

-- Update tags for each measure (clearing system tags and adding realistic ones)
UPDATE measures SET tags = ARRAY['surveillance', 'hearing', 'osha']
WHERE name = 'Audiogram';

UPDATE measures SET tags = ARRAY['surveillance', 'hazmat', 'osha']
WHERE name = 'HAZWOPER Surveillance';

UPDATE measures SET tags = ARRAY['surveillance', 'infection-control', 'cdc']
WHERE name = 'TB Surveillance';

UPDATE measures SET tags = ARRAY['vaccine', 'seasonal', 'immunization']
WHERE name = 'Flu Vaccine';

-- Update measure version approved_by to reflect personas
UPDATE measure_versions mv
SET approved_by = 'Dr. R. Patel (Medical Director)'
WHERE EXISTS (
    SELECT 1 FROM measures m WHERE m.id = mv.measure_id
    AND m.name IN ('Audiogram', 'HAZWOPER Surveillance', 'TB Surveillance', 'Flu Vaccine')
)
AND mv.status = 'ACTIVE';
```

**Step 2: Verify the migration applies cleanly**
```bash
cd backend
./gradlew.bat bootRun
# Check startup logs for Flyway: "Successfully applied migration V015"
```

**Step 3: Update the Measures page to show Tags as colored chips**

The `tags` column currently is not shown in the measures list table. Add it:
```tsx
// In frontend/app/(dashboard)/measures/page.tsx
// In the table header, add a Tags column:
<th>Tags</th>

// In the table row:
<td>
  <div className="flex flex-wrap gap-1">
    {measure.tags?.map(tag => (
      <span key={tag} className="px-1.5 py-0.5 text-xs rounded bg-muted">
        {tag}
      </span>
    ))}
  </div>
</td>
```

**Step 4: Commit**
```bash
git add backend/src/main/resources/db/migration/V015__seed_measure_owners_and_tags.sql
git add frontend/app/(dashboard)/measures/page.tsx
git commit -m "feat(seed): realistic measure owners, personas, and tag chips in measures list"
```

### Acceptance Criteria
- [ ] Audiogram shows Owner "J. Chen", tags: surveillance, hearing, osha
- [ ] HAZWOPER shows Owner "M. Patel", tags: surveillance, hazmat, osha
- [ ] TB Surveillance shows Owner "K. Williams", tags: surveillance, infection-control, cdc
- [ ] Flu Vaccine shows Owner "K. Williams", tags: vaccine, seasonal, immunization
- [ ] Tags display as chips in the measures list table

---

## Issue 2.2 — Measure Catalog Has Only 4 Active Measures (v0 Had 8)

### Current Behavior
The live catalog shows 4 active measures + 1 deprecated. The v0 prototype showed 8 measures with more variety — including Respiratory Fit Test (v0.9 Draft), Hepatitis B Vaccination Series (v2.0 Approved), Lead Medical Surveillance (v1.1 Deprecated), and Baseline Audiogram New Hire (v1.0 Active). A richer catalog makes the product feel like a real OH program platform, not a single-measure demo.

### Desired Behavior
The measure catalog contains 7–8 measures in various lifecycle states, matching the v0 prototype. Non-active measures (Draft, Approved) don't need working CQL — they just need the record and spec metadata to exist for catalog browsing.

### Files to Modify
- `backend/src/main/resources/db/migration/V016__seed_additional_measures.sql` — new migration

### Implementation Steps

**Step 1: Create migration V016 with additional measures**
```sql
-- V016__seed_additional_measures.sql

-- Measure: Respirator Fit Test (Draft - no CQL yet)
INSERT INTO measures (id, name, policy_ref, owner, tags, created_at, updated_at)
VALUES (
    gen_random_uuid(),
    'Respirator Fit Test',
    'OSHA 29 CFR 1910.134',
    'J. Chen',
    ARRAY['surveillance', 'respiratory', 'osha'],
    NOW(), NOW()
);

-- Add a Draft measure_version for Respirator Fit Test
INSERT INTO measure_versions (id, measure_id, version, status, spec_json, cql_text,
                              compile_status, change_summary, created_at)
SELECT
    gen_random_uuid(),
    m.id,
    'v0.9',
    'DRAFT',
    '{
        "description": "Annual medical evaluation and fit test for employees required to use respiratory protection under OSHA 1910.134.",
        "eligibilityCriteria": {
            "roleFilter": "Maintenance Tech, Paint Crew, Chemical Handler",
            "siteFilter": "Plant A, Plant B",
            "programEnrollmentText": "Enrolled in Respiratory Protection Program"
        },
        "exclusions": [{"label": "Medical Clearance Waiver", "criteriaText": "Physician-issued respirator clearance waiver on file"}],
        "complianceWindow": "365 days from last fit test",
        "requiredDataElements": ["Respirator Type", "Last Fit Test Date", "Medical Clearance Status"]
    }'::jsonb,
    NULL,
    'NOT_COMPILED',
    'Initial draft from OSHA 1910.134 requirements',
    NOW()
FROM measures m WHERE m.name = 'Respirator Fit Test';

-- Measure: Hepatitis B Vaccination Series (Approved)
INSERT INTO measures (id, name, policy_ref, owner, tags, created_at, updated_at)
VALUES (
    gen_random_uuid(),
    'Hepatitis B Vaccination Series',
    'OSHA 29 CFR 1910.1030',
    'K. Williams',
    ARRAY['vaccine', 'bbp', 'osha'],
    NOW(), NOW()
);

INSERT INTO measure_versions (id, measure_id, version, status, spec_json, cql_text,
                              compile_status, approved_by, created_at)
SELECT
    gen_random_uuid(),
    m.id,
    'v2.0',
    'APPROVED',
    '{
        "description": "Hepatitis B vaccination series completion for employees with occupational exposure to blood or other potentially infectious materials.",
        "eligibilityCriteria": {
            "roleFilter": "Nurse, Lab Technician, Phlebotomist, Emergency Responder",
            "siteFilter": "Clinic, Medical Center",
            "programEnrollmentText": "Bloodborne pathogen exposure risk role"
        },
        "exclusions": [{"label": "Documented Immunity", "criteriaText": "Positive anti-HBs titer on file"}],
        "complianceWindow": "Series of 3 doses over 6 months",
        "requiredDataElements": ["HBV Dose 1 Date", "HBV Dose 2 Date", "HBV Dose 3 Date", "Anti-HBs Titer Result"]
    }'::jsonb,
    '-- Hepatitis B CQL placeholder pending value set finalization',
    'COMPILED',
    'Dr. R. Patel (Medical Director)',
    NOW()
FROM measures m WHERE m.name = 'Hepatitis B Vaccination Series';

-- Measure: Lead Medical Surveillance (Deprecated)
INSERT INTO measures (id, name, policy_ref, owner, tags, created_at, updated_at)
VALUES (
    gen_random_uuid(),
    'Lead Medical Surveillance',
    'OSHA 29 CFR 1910.1025',
    'M. Patel',
    ARRAY['surveillance', 'lead', 'osha'],
    NOW() - INTERVAL '24 months', NOW() - INTERVAL '6 months'
);

INSERT INTO measure_versions (id, measure_id, version, status, spec_json,
                              compile_status, change_summary, created_at)
SELECT
    gen_random_uuid(),
    m.id,
    'v1.1',
    'DEPRECATED',
    '{
        "description": "DEPRECATED — Replaced by updated Lead Exposure Monitoring Protocol. Blood lead level monitoring for employees exposed to lead above the action level.",
        "eligibilityCriteria": {
            "roleFilter": "Battery Plant Worker, Smelter, Lead Paint Handler",
            "siteFilter": "Plant A",
            "programEnrollmentText": "Lead exposure > action level (30 μg/m³)"
        },
        "complianceWindow": "Every 6 months for blood lead monitoring"
    }'::jsonb,
    'COMPILED',
    'Deprecated — superseded by updated OSHA interpretations in 2024',
    NOW() - INTERVAL '6 months'
FROM measures m WHERE m.name = 'Lead Medical Surveillance';
```

**Step 2: Verify the catalog renders the new measures**

Navigate to `/measures` and confirm:
- Respirator Fit Test appears with status "Draft"
- Hepatitis B Vaccination Series appears with status "Approved"
- Lead Medical Surveillance appears with status "Deprecated"

**Step 3: Commit**
```bash
git add backend/src/main/resources/db/migration/V016__seed_additional_measures.sql
git commit -m "feat(seed): add Respirator Fit Test, Hepatitis B, Lead Surveillance to measure catalog"
```

### Acceptance Criteria
- [ ] Measure catalog shows 7+ measures in various lifecycle states
- [ ] Respirator Fit Test: Draft, v0.9, J. Chen
- [ ] Hepatitis B Vaccination Series: Approved, v2.0, K. Williams
- [ ] Lead Medical Surveillance: Deprecated, v1.1, M. Patel
- [ ] Existing 4 active measures are unaffected

---

## Issue 2.3 — Trend Charts Have No Date Axis, Scale, or Tooltips

### Current Behavior
The Programs Overview shows a trend line ("TREND") for each measure with a line chart rendered using what appears to be a simple SVG or chart library. The chart has:
- No X-axis date labels
- No Y-axis percentage scale
- No hover tooltips showing exact values
- No date range indicator
- The trend line for Audiogram and HAZWOPER is a single downward L-shape — not enough data points to show a real trend

**Evidence:** Programs Overview screenshot — trend charts are present but uninterpretable.

### Desired Behavior
Each trend chart shows:
- X-axis with month labels (e.g., "Jan", "Feb", "Mar", "Apr", "May")
- Y-axis with percentage labels (70%, 80%, 90%)
- A hover tooltip showing "April: 78.5% compliant (97/123 employees)"
- A percentage delta badge: "+2.3% from last month" in green, or "-1.1%" in red
- At least 3 data points — run at different dates — for the trend to be meaningful

### Root Cause
Two problems:
1. The chart library (likely Recharts or a minimal custom chart) is not configured with axes or tooltips
2. The seed historical run data may not have enough variation across dates to produce a meaningful trend

### Files to Modify
- `frontend/app/(dashboard)/programs/page.tsx` — enhance trend chart component
- `backend/src/main/resources/db/migration/V017__seed_historical_run_summary.sql` — more spread-out historical runs

### Implementation Steps

**Step 1: Check what chart library is in use**
```bash
grep -r "recharts\|chart\|sparkline" frontend/package.json frontend/
```

If Recharts is not installed:
```bash
cd frontend && pnpm add recharts
```

**Step 2: Replace the bare trend line with a proper Recharts `ResponsiveContainer`**
```tsx
// In programs/page.tsx or a TrendChart component:
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  Tooltip, CartesianGrid
} from 'recharts'

interface TrendPoint {
  date: string   // "2026-03-15"
  label: string  // "Mar"
  passRate: number // 0.783
}

function TrendChart({ data }: { data: TrendPoint[] }) {
  if (!data || data.length < 2) {
    return (
      <div className="h-24 flex items-center justify-center text-xs text-muted-foreground">
        Not enough run history for trend
      </div>
    )
  }

  const delta = data.length >= 2
    ? ((data[data.length - 1].passRate - data[data.length - 2].passRate) * 100).toFixed(1)
    : null

  return (
    <div className="space-y-1">
      {delta !== null && (
        <span className={`text-xs font-medium ${parseFloat(delta) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
          {parseFloat(delta) >= 0 ? '↑' : '↓'} {Math.abs(parseFloat(delta))}% from last run
        </span>
      )}
      <ResponsiveContainer width="100%" height={80}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={v => `${(v * 100).toFixed(0)}%`}
            domain={[0.5, 1]}
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <Tooltip
            formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, 'Compliance']}
            labelFormatter={label => `Period: ${label}`}
            contentStyle={{ fontSize: 11 }}
          />
          <Line
            type="monotone"
            dataKey="passRate"
            stroke="#2563eb"
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
```

**Step 3: Map backend trend data to `TrendPoint[]`**

The backend `GET /api/programs/{measureId}/trend` endpoint returns run history for the measure. Map it:
```tsx
const trendData: TrendPoint[] = trend.map(point => ({
  date: point.runDate,
  label: new Date(point.runDate).toLocaleDateString('en', { month: 'short' }),
  passRate: point.passRate / 100,  // if backend returns 78.5, convert to 0.785
}))
```

**Step 4: Seed more historical run data for meaningful trends**

Create `V017__seed_historical_run_summary.sql` that inserts run records at specific past dates so the trend shows meaningful variation:
```sql
-- V017__seed_historical_run_summary.sql
-- Note: this seeds summary-level historical data for trend visualization
-- The detailed outcome rows are not re-seeded (too much data) — trend uses run-level aggregates

-- Insert historical run summary records for Audiogram across past 5 months
-- These complement the existing detailed seeded runs

WITH audiogram_version AS (
    SELECT mv.id as version_id FROM measure_versions mv
    JOIN measures m ON mv.measure_id = m.id
    WHERE m.name = 'Audiogram' AND mv.status = 'ACTIVE'
    LIMIT 1
)
INSERT INTO runs (
    id, scope_type, scope_id, trigger_type, status, triggered_by,
    started_at, completed_at, total_evaluated, compliant, non_compliant,
    duration_ms, measurement_period_start, measurement_period_end,
    requested_scope_json, failure_summary, partial_failure_count, dry_run
)
SELECT
    gen_random_uuid(),
    'MEASURE', av.version_id, 'SCHEDULED', 'COMPLETED', 'scheduler',
    NOW() - (n || ' months')::interval,
    NOW() - (n || ' months')::interval + INTERVAL '4 minutes',
    100,
    -- Simulate declining compliance for trend interest
    GREATEST(60, 85 - (n * 2)),
    LEAST(40, 15 + (n * 2)),
    240000,
    NOW() - ((n + 1) || ' months')::interval,
    NOW() - (n || ' months')::interval,
    '{"scopeType":"MEASURE"}'::jsonb,
    NULL, 0, false
FROM generate_series(1, 5) AS n, audiogram_version av
ON CONFLICT DO NOTHING;
```

**Step 5: Verify trend charts render correctly**

After deploying the migration and frontend changes, the Programs Overview should show:
- At least 3-5 data points per measure
- Visible date labels on X-axis
- Percentage labels on Y-axis
- Delta badge ("↑ 2.3% from last run")

**Step 6: Commit**
```bash
git add frontend/ backend/src/main/resources/db/migration/V017__seed_historical_run_summary.sql
git commit -m "feat(ui): proper trend charts with axes, tooltips, delta badges on Programs Overview"
```

### Acceptance Criteria
- [ ] Each measure card on Programs Overview shows a trend chart with visible X-axis month labels
- [ ] Y-axis shows percentage scale
- [ ] Hover tooltip shows compliance percentage for that date
- [ ] Delta badge shows percentage change from previous run (green/red)
- [ ] Charts with < 2 data points show a "Not enough history" fallback message

---

## Issue 2.4 — Top Drivers Section Lacks Reason Code Breakdown

### Current Behavior
The Programs Overview shows "Top Sites" and "Top Roles" for non-compliance drivers, but only with a count (e.g., "Clinic: 27", "Plant B: 5"). The v0 prototype showed:
- BY SITE with annotation: "Clinic: 9 overdue — **High patient volume**"
- BY ROLE with annotation: "Nurse: 7 overdue — **Night shift coverage**"
- BY REASON CODE: "MISS_ANNUAL: 11 cases (79%)", "WAIVED: 3 cases (21%)"

The live app shows counts but no annotations, no reason code breakdown, and no percentage context.

### Desired Behavior
Each top-driver entry shows a count + contextual annotation (from outcome status) + a percentage of total non-compliant. A new "By Reason Code" section shows the distribution of outcome statuses (`DUE_SOON`, `OVERDUE`, `MISSING_DATA`) as a breakdown.

### Files to Modify
- `backend/src/main/java/com/workwell/web/ProgramController.java` — enhance top-drivers response
- `backend/src/main/java/com/workwell/program/ProgramService.java` — add reason code breakdown
- `frontend/app/(dashboard)/programs/page.tsx` — render enhanced drivers

### Implementation Steps

**Step 1: Enhance the top-drivers backend response**

`GET /api/programs/{measureId}/top-drivers` should return:
```json
{
  "bySite": [
    { "site": "Clinic", "count": 27, "percentage": 53, "topReason": "OVERDUE" }
  ],
  "byRole": [
    { "role": "Nurse", "count": 10, "percentage": 20, "topReason": "OVERDUE" }
  ],
  "byReasonCode": [
    { "code": "OVERDUE", "label": "Overdue", "count": 23, "percentage": 74 },
    { "code": "DUE_SOON", "label": "Due Soon", "count": 5, "percentage": 16 },
    { "code": "MISSING_DATA", "label": "Missing Data", "count": 3, "percentage": 10 }
  ]
}
```

Update `ProgramService.java` to compute this:
```java
public ProgramDriversDto getTopDrivers(UUID measureVersionId) {
    // Query non-compliant outcomes for the latest run
    // GROUP BY site + outcome status to get bySite with topReason
    // GROUP BY role + outcome status to get byRole with topReason
    // GROUP BY status to get byReasonCode
}
```

**Step 2: Update the frontend to render reason code breakdown**
```tsx
{/* By Reason Code section */}
{drivers.byReasonCode && (
  <div className="mt-3">
    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
      By Reason
    </p>
    {drivers.byReasonCode.map(reason => (
      <div key={reason.code} className="flex items-center justify-between text-xs mb-1">
        <span className={`px-1.5 py-0.5 rounded font-medium ${
          reason.code === 'OVERDUE' ? 'bg-red-100 text-red-700' :
          reason.code === 'DUE_SOON' ? 'bg-yellow-100 text-yellow-700' :
          'bg-gray-100 text-gray-600'
        }`}>
          {reason.label}
        </span>
        <span className="text-muted-foreground">
          {reason.count} cases ({reason.percentage}%)
        </span>
      </div>
    ))}
  </div>
)}
```

**Step 3: Commit**
```bash
git commit -m "feat(programs): add reason code breakdown and percentages to top drivers"
```

### Acceptance Criteria
- [ ] Top Sites shows count + percentage of total non-compliant
- [ ] Top Roles shows count + percentage
- [ ] "By Reason Code" section shows breakdown of OVERDUE / DUE_SOON / MISSING_DATA with counts and percentages
- [ ] Reason codes are color-coded (red for overdue, yellow for due soon)

---

## Issue 2.5 — Case Assignees Are All "system" or Blank

### Current Behavior
Seeded cases have no assignees or are assigned to "system". In a real case management context, cases are assigned to specific compliance officers or case managers. Seeing blank/system assignees makes the worklist look unused.

### Files to Modify
- `backend/src/main/resources/db/migration/V018__seed_case_assignees.sql` — new migration

### Implementation Steps

**Step 1: Create migration V018 to assign cases to named personas**
```sql
-- V018__seed_case_assignees.sql
-- Distribute open cases across named case managers

-- Assign ~30% of open cases to Sarah Mitchell (Case Manager)
UPDATE cases
SET assignee = 'Sarah Mitchell'
WHERE status = 'OPEN'
  AND id IN (
    SELECT id FROM cases WHERE status = 'OPEN'
    ORDER BY created_at
    LIMIT (SELECT CEIL(COUNT(*) * 0.3)::int FROM cases WHERE status = 'OPEN')
  );

-- Assign ~30% to James Torres
UPDATE cases
SET assignee = 'James Torres'
WHERE status = 'OPEN' AND assignee IS NULL
  AND id IN (
    SELECT id FROM cases WHERE status = 'OPEN' AND assignee IS NULL
    ORDER BY created_at
    LIMIT (SELECT CEIL(COUNT(*) * 0.3)::int FROM cases WHERE status = 'OPEN' AND assignee IS NULL)
  );

-- Leave remaining cases unassigned (realistic — some cases enter the queue without assignee)
```

**Step 2: Verify**

Navigate to `/cases` and confirm cases show "Sarah Mitchell" and "James Torres" as assignees with some unassigned.

**Step 3: Commit**
```bash
git add backend/src/main/resources/db/migration/V018__seed_case_assignees.sql
git commit -m "feat(seed): assign open cases to named case manager personas"
```

### Acceptance Criteria
- [ ] Cases list shows named assignees (Sarah Mitchell, James Torres)
- [ ] ~40% of cases remain unassigned (realistic queue)
- [ ] Assignee filter on cases list works correctly with the new names

---

## Issue 2.6 — Loading States Are Blank White Screens

### Current Behavior
While API calls are in-flight, most pages render a blank white area or a minimal "Loading..." text. There are no skeleton loaders or shimmer placeholders. The transition from blank → populated is jarring, especially on slower connections.

### Desired Behavior
During data loading, each page shows skeleton placeholder cards that match the approximate shape of the loaded content. This is table stakes for professional enterprise UI.

### Files to Modify
- `frontend/app/(dashboard)/programs/page.tsx` — skeleton for measure cards
- `frontend/app/(dashboard)/cases/page.tsx` — skeleton for case table rows
- `frontend/app/(dashboard)/runs/page.tsx` — skeleton for run table rows

### Implementation Steps

**Step 1: Create a reusable `SkeletonCard` and `SkeletonRow` component**
```tsx
// frontend/components/ui/skeleton-loader.tsx
export function SkeletonCard() {
  return (
    <div className="border rounded-lg p-4 space-y-3 animate-pulse">
      <div className="flex justify-between items-start">
        <div className="h-4 bg-muted rounded w-1/3" />
        <div className="h-6 bg-muted rounded w-12" />
      </div>
      <div className="flex gap-2">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-5 bg-muted rounded w-16" />
        ))}
      </div>
      <div className="h-16 bg-muted rounded" />
    </div>
  )
}

export function SkeletonRow({ cols = 6 }: { cols?: number }) {
  return (
    <tr className="animate-pulse">
      {[...Array(cols)].map((_, i) => (
        <td key={i} className="py-3 px-4">
          <div className="h-4 bg-muted rounded" style={{ width: `${60 + i * 10}%` }} />
        </td>
      ))}
    </tr>
  )
}
```

**Step 2: Use skeletons in programs page**
```tsx
// In programs/page.tsx
if (loading) {
  return (
    <div className="grid grid-cols-2 gap-4">
      {[...Array(4)].map((_, i) => <SkeletonCard key={i} />)}
    </div>
  )
}
```

**Step 3: Use skeletons in cases and runs pages**
```tsx
// In cases/page.tsx and runs/page.tsx
if (loading) {
  return (
    <table>
      <tbody>
        {[...Array(10)].map((_, i) => <SkeletonRow key={i} cols={7} />)}
      </tbody>
    </table>
  )
}
```

**Step 4: Commit**
```bash
git add frontend/components/ui/skeleton-loader.tsx frontend/app/(dashboard)/
git commit -m "feat(ui): add skeleton loading states to programs, cases, and runs pages"
```

### Acceptance Criteria
- [ ] Programs Overview shows 4 skeleton cards while loading
- [ ] Cases list shows skeleton rows while loading
- [ ] Runs list shows skeleton rows while loading
- [ ] Skeletons animate with a subtle pulse
- [ ] Transition from skeleton to loaded content is smooth (no flash of white)

---

## Sprint 2 Definition of Done

- [ ] All measures show named human owners (J. Chen, M. Patel, K. Williams)
- [ ] Tags display as chips in measures list
- [ ] Measure catalog has 7+ measures in various lifecycle states
- [ ] Trend charts on Programs Overview show axes, tooltips, and delta badges
- [ ] Top drivers section shows reason code breakdown with percentages
- [ ] Open cases have named assignees (Sarah Mitchell, James Torres)
- [ ] All pages show skeleton loading states (no blank white flashes)
- [ ] All Flyway migrations apply cleanly on a fresh deploy
- [ ] Deployed and verified on Fly + Vercel

**Branch to merge:** `feat/sprint-2-demo-data-visual`
**PR title:** `feat: Sprint 2 — realistic seed data, trend charts with axes, skeleton loaders`
