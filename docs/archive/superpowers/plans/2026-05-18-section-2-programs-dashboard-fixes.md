# Section 2 Programs Dashboard Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 6 code bugs in GitHub issue #25 (UAT Section 2) and correct the matching guide inaccuracies in `docs/WALKTHROUGH_GUIDE.md`.

**Architecture:** Four independent, sequential commits — two frontend (same file), one backend SQL, one docs. Bug 7 (`fly.toml` `min_machines_running = 1`) is already present and requires no change.

**Tech Stack:** Next.js 14 App Router + TypeScript + Tailwind (frontend); Spring Boot 3 + JdbcTemplate (backend).

**Branch:** Create `fix/section-2-programs-dashboard` off `main`.

---

## Pre-flight

- [ ] **Create feature branch**

```bash
git checkout main && git pull origin main
git checkout -b fix/section-2-programs-dashboard
```

- [ ] **Confirm Bug 7 is already done**

`backend/fly.toml` line 22: `min_machines_running = 1` — no change needed.

---

## Task 1 — Fix TrendChart sparkline (Bugs 1 + 2)

**Files:**
- Modify: `frontend/app/(dashboard)/programs/page.tsx` — `TrendChart` function (lines 331–387)

### What's wrong

**Bug 1:** `toLocaleDateString("en", { month: "short" })` produces `"May"` for every run in the same calendar month — no day component, so all x-axis labels are identical.

**Bug 2:** Runs with `totalEvaluated === 0` (stale/queued records) produce `complianceRate: 0`, which renders as `"Compliance: 0%"` in the tooltip even though the run had no employees. These should be excluded from the chart.

### The fix

Both bugs are in the `sorted` computation inside `TrendChart`. The fix is two lines:

```typescript
// OLD (line 340-344):
const sorted = [...data].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

const chartData = sorted.map((t) => ({
  label: new Date(t.startedAt).toLocaleDateString("en", { month: "short" }),
  rate: Math.round(t.complianceRate * 10) / 10,
}));

// NEW:
const sorted = [...data]
  .filter((t) => t.totalEvaluated > 0)
  .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

const chartData = sorted.map((t) => ({
  label: new Date(t.startedAt).toLocaleDateString("en", { month: "short", day: "numeric" }),
  rate: Math.round(t.complianceRate * 10) / 10,
}));
```

The `totalEvaluated > 0` filter also needs to be applied before the `data.length < 2` guard, since filtering can reduce a 3-element array to 1 element (which should show the "not enough history" placeholder rather than a broken chart). Move the guard after filtering:

```typescript
// OLD (lines 331-338):
function TrendChart({ data }: { data: TrendPoint[] }) {
  if (!data || data.length < 2) {
    return (
      <div className="flex h-[90px] items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50">
        <span className="text-xs text-slate-400">Not enough run history for trend</span>
      </div>
    );
  }

  const sorted = [...data].sort(...);

// NEW:
function TrendChart({ data }: { data: TrendPoint[] }) {
  const sorted = [...(data ?? [])]
    .filter((t) => t.totalEvaluated > 0)
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  if (sorted.length < 2) {
    return (
      <div className="flex h-[90px] items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50">
        <span className="text-xs text-slate-400">Not enough run history for trend</span>
      </div>
    );
  }
```

- [ ] **Apply the TrendChart fix**

Edit `frontend/app/(dashboard)/programs/page.tsx`. Replace the entire `TrendChart` function (lines 331–387) with:

```typescript
function TrendChart({ data }: { data: TrendPoint[] }) {
  const sorted = [...(data ?? [])]
    .filter((t) => t.totalEvaluated > 0)
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  if (sorted.length < 2) {
    return (
      <div className="flex h-[90px] items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50">
        <span className="text-xs text-slate-400">Not enough run history for trend</span>
      </div>
    );
  }

  const chartData = sorted.map((t) => ({
    label: new Date(t.startedAt).toLocaleDateString("en", { month: "short", day: "numeric" }),
    rate: Math.round(t.complianceRate * 10) / 10,
  }));

  const last = chartData[chartData.length - 1].rate;
  const prev = chartData[chartData.length - 2].rate;
  const delta = (last - prev).toFixed(1);
  const deltaPositive = parseFloat(delta) >= 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <span className={`text-xs font-medium ${deltaPositive ? "text-emerald-600" : "text-rose-600"}`}>
          {deltaPositive ? "↑" : "↓"} {Math.abs(parseFloat(delta))}% from last run
        </span>
      </div>
      <ResponsiveContainer width="100%" height={80}>
        <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis
            tickFormatter={(v: number) => `${v}%`}
            domain={["auto", 100]}
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <Tooltip
            formatter={(v) => [`${v}%`, "Compliance"]}
            contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e2e8f0" }}
          />
          <Line
            type="monotone"
            dataKey="rate"
            stroke="#2563eb"
            strokeWidth={2}
            dot={{ r: 3, fill: "#2563eb" }}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Verify TypeScript compiles**

```bash
cd frontend && pnpm build 2>&1 | tail -20
```

Expected: no TypeScript errors. Warnings about bundle size are OK.

- [ ] **Commit**

```bash
git add frontend/app/\(dashboard\)/programs/page.tsx
git commit -m "fix(programs): fix sparkline x-axis labels and filter zero-evaluated runs"
```

---

## Task 2 — Button hover state + run confirmation (Bugs 3 + 6)

**Files:**
- Modify: `frontend/app/(dashboard)/programs/page.tsx` — header section (lines 142–185) and `ProgramsPage` function state

### What's wrong

**Bug 3:** The "Run All Measures Now" button has no hover feedback. The `className` is missing `hover:bg-slate-700 transition-colors cursor-pointer`.

**Bug 6:** Clicking "Run All Measures Now" fires the run immediately with no confirmation. The walkthrough guide describes a confirmation step, and users can trigger expensive all-programs runs accidentally. The admin page (`admin/page.tsx`) has an established inline confirmation pattern to follow.

### The fix

Add a `showRunConfirm` state boolean, then restructure the header button area to follow the same inline confirm pattern used in `admin/page.tsx`.

- [ ] **Add showRunConfirm state**

In `ProgramsPage`, after the existing `useState` declarations (around line 55), add:

```typescript
const [showRunConfirm, setShowRunConfirm] = useState(false);
```

- [ ] **Replace the header button area**

Locate this block in `ProgramsPage` (lines 169–185):

```tsx
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold">Programs Overview</h2>
        <div className="flex items-center gap-3">
          {activeRunId ? (
            <span className="text-sm text-slate-500 animate-pulse">
              {activeRunStatus === "REQUESTED" ? "Queued…" : "Running…"} ({activeRunStatus.toLowerCase()})
            </span>
          ) : null}
          <button
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            onClick={() => void runAllMeasuresNow()}
            disabled={activeRunId !== null}
          >
            {activeRunId ? "Running…" : "Run All Measures Now"}
          </button>
        </div>
      </div>
```

Replace with:

```tsx
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold">Programs Overview</h2>
        <div className="flex items-center gap-3">
          {activeRunId ? (
            <span className="text-sm text-slate-500 animate-pulse">
              {activeRunStatus === "REQUESTED" ? "Queued…" : "Running…"} ({activeRunStatus.toLowerCase()})
            </span>
          ) : showRunConfirm ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-slate-700">Run all 4 active programs now?</span>
              <button
                type="button"
                onClick={() => { setShowRunConfirm(false); void runAllMeasuresNow(); }}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 transition-colors"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setShowRunConfirm(false)}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 cursor-pointer transition-colors"
              onClick={() => setShowRunConfirm(true)}
            >
              Run All Measures Now
            </button>
          )}
        </div>
      </div>
```

Key changes:
- Button no longer calls `runAllMeasuresNow()` directly — it sets `showRunConfirm = true`
- When `showRunConfirm` is true, confirm/cancel UI replaces the button (matching admin page pattern)
- When `activeRunId` is set (run in progress), the running indicator takes over; both button and confirm UI are hidden — no `disabled` prop needed
- Button has `hover:bg-slate-700 transition-colors cursor-pointer` (Bug 3 fix)
- Added `type="button"` to all buttons (prevents accidental form submission if ever wrapped in a form)

- [ ] **Verify TypeScript compiles**

```bash
cd frontend && pnpm build 2>&1 | tail -20
```

Expected: no TypeScript errors.

- [ ] **Commit**

```bash
git add frontend/app/\(dashboard\)/programs/page.tsx
git commit -m "fix(programs): add hover state and inline confirmation to Run All Measures button"
```

---

## Task 3 — Fix per-measure driver data scoping (Bug 5)

**Files:**
- Modify: `backend/src/main/java/com/workwell/program/ProgramService.java` — `topDrivers` method (lines 203–298)

### Root cause analysis

`topDrivers(measureId, ...)` works in two phases:

1. **Find `latestRunId`:** Query outcomes joined to `active_measure_version` (filtered by `measureId`). Because of the CTE join, only outcomes belonging to this measure's version are considered. ✓ Correct.

2. **Query drivers using `latestRunId`:** Three sub-queries (`bySite`, `byRole`, `byOutcomeReason`) filter **only by `run_id`**, not by `measure_version_id`.

When the last run was `ALL_PROGRAMS` scoped, all four measures write outcomes to the **same `run_id`**. So `latestRunId` is shared across all four measure cards. The driver sub-queries then aggregate outcomes across all four measures in that run — producing identical results on every card.

**The fix:** resolve `measureVersionId` upfront with a one-row query, then add `AND o.measure_version_id = ?` to every driver sub-query. This narrows each query to outcomes belonging to this specific measure version only.

- [ ] **Replace the `topDrivers` method**

In `backend/src/main/java/com/workwell/program/ProgramService.java`, replace the full `topDrivers` method (lines 203–298) with:

```java
public TopDrivers topDrivers(UUID measureId, String site, Instant from, Instant to) {
    UUID measureVersionId = jdbcTemplate.query(
            """
            SELECT mv.id
            FROM measure_versions mv
            WHERE mv.measure_id = ?
            ORDER BY mv.created_at DESC
            LIMIT 1
            """,
            rs -> rs.next() ? (UUID) rs.getObject("id") : null,
            measureId
    );

    if (measureVersionId == null) {
        return new TopDrivers(List.of(), List.of(), List.of());
    }

    UUID latestRunId = jdbcTemplate.query(
            """
            SELECT o.run_id
            FROM outcomes o
            JOIN runs r ON r.id = o.run_id
            JOIN employees e ON e.id = o.employee_id
            WHERE o.measure_version_id = ?
              AND (CAST(? AS TEXT) IS NULL OR LOWER(COALESCE(e.site, '')) = LOWER(CAST(? AS TEXT)))
              AND (CAST(? AS TIMESTAMPTZ) IS NULL OR r.started_at >= CAST(? AS TIMESTAMPTZ))
              AND (CAST(? AS TIMESTAMPTZ) IS NULL OR r.started_at <= CAST(? AS TIMESTAMPTZ))
            GROUP BY o.run_id, r.started_at
            ORDER BY r.started_at DESC
            LIMIT 1
            """,
            rs -> rs.next() ? (UUID) rs.getObject("run_id") : null,
            measureVersionId,
            site, site,
            from == null ? null : Timestamp.from(from), from == null ? null : Timestamp.from(from),
            to == null ? null : Timestamp.from(to), to == null ? null : Timestamp.from(to)
    );

    if (latestRunId == null) {
        return new TopDrivers(List.of(), List.of(), List.of());
    }

    List<DriverSite> bySite = jdbcTemplate.query(
            """
            SELECT e.site, COUNT(*) AS overdue_count
            FROM outcomes o
            JOIN employees e ON e.id = o.employee_id
            WHERE o.run_id = ? AND o.measure_version_id = ? AND o.status = 'OVERDUE'
              AND (CAST(? AS TEXT) IS NULL OR LOWER(COALESCE(e.site, '')) = LOWER(CAST(? AS TEXT)))
            GROUP BY e.site
            ORDER BY overdue_count DESC, e.site ASC
            LIMIT 5
            """,
            (rs, rowNum) -> new DriverSite(
                    rs.getString("site"),
                    rs.getLong("overdue_count"),
                    "High overdue concentration"
            ),
            latestRunId, measureVersionId, site, site
    );

    List<DriverRole> byRole = jdbcTemplate.query(
            """
            SELECT e.role, COUNT(*) AS overdue_count
            FROM outcomes o
            JOIN employees e ON e.id = o.employee_id
            WHERE o.run_id = ? AND o.measure_version_id = ? AND o.status = 'OVERDUE'
              AND (CAST(? AS TEXT) IS NULL OR LOWER(COALESCE(e.site, '')) = LOWER(CAST(? AS TEXT)))
            GROUP BY e.role
            ORDER BY overdue_count DESC, e.role ASC
            LIMIT 5
            """,
            (rs, rowNum) -> new DriverRole(
                    rs.getString("role"),
                    rs.getLong("overdue_count")
            ),
            latestRunId, measureVersionId, site, site
    );

    long totalFlagged = jdbcTemplate.queryForObject(
            """
            SELECT COUNT(*)
            FROM outcomes o
            JOIN employees e ON e.id = o.employee_id
            WHERE o.run_id = ? AND o.measure_version_id = ?
              AND o.status IN ('OVERDUE', 'MISSING_DATA', 'DUE_SOON')
              AND (CAST(? AS TEXT) IS NULL OR LOWER(COALESCE(e.site, '')) = LOWER(CAST(? AS TEXT)))
            """,
            Long.class,
            latestRunId, measureVersionId, site, site
    );

    org.springframework.jdbc.core.RowMapper<DriverOutcomeReason> reasonMapper = (rs, rowNum) -> {
        long count = rs.getLong("cnt");
        double pct = totalFlagged == 0 ? 0d : Math.round((count * 1000.0 / totalFlagged)) / 10.0;
        return new DriverOutcomeReason(rs.getString("reason"), count, pct);
    };
    List<DriverOutcomeReason> byOutcomeReason = jdbcTemplate.query(
            """
            SELECT o.status AS reason, COUNT(*) AS cnt
            FROM outcomes o
            JOIN employees e ON e.id = o.employee_id
            WHERE o.run_id = ? AND o.measure_version_id = ?
              AND o.status IN ('OVERDUE', 'MISSING_DATA', 'DUE_SOON')
              AND (CAST(? AS TEXT) IS NULL OR LOWER(COALESCE(e.site, '')) = LOWER(CAST(? AS TEXT)))
            GROUP BY o.status
            ORDER BY cnt DESC
            """,
            reasonMapper,
            latestRunId, measureVersionId, site, site
    );

    return new TopDrivers(bySite, byRole, byOutcomeReason);
}
```

**What changed vs. the original:**
- New first query resolves `measureVersionId` (active version for this measure).
- `latestRunId` query simplified: CTE removed; directly uses `WHERE o.measure_version_id = ?` to scope to this measure's version.
- All five driver queries now include `AND o.measure_version_id = ?` as a second bind parameter after `run_id`.
- `totalFlagged` query reformatted to a text block for consistency and readability.

- [ ] **Run backend tests**

```bash
cd backend && ./gradlew.bat test 2>&1 | tail -30
```

Expected: `BUILD SUCCESSFUL`. The existing `ProgramControllerTest.returnsTopDrivers` test will still pass — it mocks `ProgramService` entirely, so the SQL change does not affect it.

- [ ] **Commit**

```bash
git add backend/src/main/java/com/workwell/program/ProgramService.java
git commit -m "fix(programs): scope driver breakdown queries to the specific measure version"
```

---

## Task 4 — Fix WALKTHROUGH_GUIDE.md Section 2 inaccuracies

**Files:**
- Modify: `docs/WALKTHROUGH_GUIDE.md` — Section 2 (lines ~80–115)

### Inaccuracies to fix (from issue #25)

| Location | Current (wrong) | Correct |
|----------|-----------------|---------|
| Step 2, KPI 1 | "Total Employees Evaluated" | "Employees tracked" |
| Step 2, KPI 2 | "Overall Pass Rate" | "Overall compliance" |
| Step 2, KPI 4 | "Trend indicator — whether compliance is improving…" | "Last run — timestamp of the most recent completed run" |
| Step 3, measure order | Audiogram, HAZWOPER, TB, Flu | Audiogram, Flu Vaccine, HAZWOPER, TB |
| Step 4, card contents | Includes "Last run timestamp" | Remove — last run is KPI-row only, not per-card |
| Step 5 | Global "Top Non-Compliance Drivers" table | Each card has inline By Reason / Top Sites / Top Roles sections |
| Step 1 note | Missing sidebar labels | Note: sidebar shows "Test Runs" for the Runs page; "Worklist" is a separate sidebar item |
| Step 10 | "5–15 seconds" | Account for cold-start; first request after idle may take up to 30–45 s on Fly free tier |

- [ ] **Apply Step 1 sidebar note**

Find the text:
```
1. After login, you should already be on `/programs`. If not, click **Programs** in the left sidebar.
```

Replace with:
```
1. After login, you should already be on `/programs`. If not, click **Programs** in the left sidebar.
   > **Sidebar labels:** The Runs page is labelled **Test Runs** in the sidebar, not "Runs". The cases worklist has two entries: **Cases** and **Worklist** — both go to `/cases`.
```

- [ ] **Apply Step 2 KPI corrections**

Find:
```
   - **Total Employees Evaluated** — how many employees were assessed in the most recent run across all measures
   - **Overall Pass Rate** — percentage currently compliant across all active programs (e.g., 72%)
   - **Open Cases** — total non-compliance work items that need action
   - **Trend indicator** — whether compliance is improving or declining vs. the previous run
```

Replace with:
```
   - **Employees tracked** — total employees assessed in the most recent run across all measures
   - **Overall compliance** — percentage currently compliant across all active programs (e.g., 72.0%)
   - **Open cases** — total non-compliance work items that need action
   - **Last run** — timestamp of the most recent completed run across all programs
```

- [ ] **Apply Step 3 measure card order correction**

Find:
```
   - Annual Audiogram (OSHA 1910.95)
   - HAZWOPER Annual Medical Surveillance (OSHA 1910.120)
   - Annual TB Screening (CDC guidance)
   - Flu Vaccine This Season
```

Replace with:
```
   - Annual Audiogram Completed (OSHA 1910.95)
   - Flu Vaccine This Season
   - HAZWOPER Annual Medical Surveillance (OSHA 1910.120)
   - Annual TB Screening
```

- [ ] **Apply Step 4 card contents correction**

Find:
```
4. Each card shows:
   - Current pass rate (e.g., "68% compliant")
   - A sparkline chart showing the trend over recent runs
   - Last run timestamp
   - Outcome breakdown (Compliant / Due Soon / Overdue / Missing Data / Excluded counts)
```

Replace with:
```
4. Each card shows:
   - Current compliance rate (e.g., "68.0%")
   - Outcome badge counts: Compliant / Due Soon / Overdue / Missing Data / Excluded
   - **Trend** sparkline — compliance rate over recent runs (requires ≥ 2 completed runs to render)
   - **Top Sites** and **Top Roles** — the sites/roles with the most overdue employees for this program
   - **By Reason** — breakdown of flagged employees by outcome type (OVERDUE / DUE_SOON / MISSING_DATA)
```

- [ ] **Apply Step 5 global table removal**

Find:
```
5. Below the cards, find the **Top Non-Compliance Drivers** table — a ranked list of the most common reasons employees are flagged (e.g., "Exam overdue by 30–90 days" → 14 employees).
```

Replace with:
```
5. Driver breakdowns are **per-card** — there is no global drivers table. Look inside each program card for the **By Reason**, **Top Sites**, and **Top Roles** sections. These show data scoped to that program's most recent run.
```

- [ ] **Apply Step 10 run timing correction**

Find:
```
10. This takes approximately 5–15 seconds depending on server load.
```

Replace with:
```
10. This takes approximately 5–15 seconds on a warm server. If the backend has been idle, Fly.io may cold-start the machine; allow up to 30–45 seconds for the first request. Subsequent requests in the session are fast.
```

- [ ] **Verify the guide renders correctly** (read it back and check for broken markdown)

```bash
grep -n "Step\|###\|##\|KPI\|card\|sparkline\|Top Sites\|Test Runs" "docs/WALKTHROUGH_GUIDE.md" | head -40
```

- [ ] **Commit**

```bash
git add docs/WALKTHROUGH_GUIDE.md
git commit -m "docs(guide): correct Section 2 Programs Dashboard inaccuracies"
```

---

## Final: push and open PR

- [ ] **Push branch**

```bash
git push -u origin fix/section-2-programs-dashboard
```

- [ ] **Open PR**

```bash
gh pr create \
  --title "fix(section-2): Programs Dashboard bugs and guide fixes (#25)" \
  --body "$(cat <<'EOF'
## Summary
- Bug 1: Sparkline x-axis now shows distinct date labels (e.g., "May 3", "May 12") instead of repeating "May"
- Bug 2: Zero-evaluated runs filtered from trend series; tooltip no longer shows "Compliance: 0%"
- Bug 3: "Run All Measures Now" button has hover state and cursor-pointer
- Bug 5: Per-measure driver breakdown (By Reason / Top Sites / Top Roles) now scoped to the specific measure version; previously all 4 cards showed identical aggregated data when the last run was ALL_PROGRAMS
- Bug 6: "Run All Measures Now" now shows inline confirmation before firing (matching admin page pattern)
- Bug 7: Already fixed — fly.toml min_machines_running = 1 was already set

## Not changed
- fly.toml: already had min_machines_running = 1

## Test plan
- [ ] pnpm build passes (TypeScript)
- [ ] ./gradlew.bat test passes (ProgramControllerTest)
- [ ] Visit /programs, trigger "Run All Measures Now" — confirm dialog appears before run starts
- [ ] After a run completes, verify each measure card shows different By Reason / Top Sites / Top Roles values
- [ ] Verify sparkline x-axis shows "May 3", "May 12" etc. (not all "May")

Closes #25
EOF
)"
```

---

## Self-review checklist

**Spec coverage:**
- [x] Bug 1 — sparkline x-axis labels → Task 1
- [x] Bug 2 — zero-evaluated tooltip → Task 1
- [x] Bug 3 — button hover state → Task 2
- [x] Bug 5 — driver data scoping → Task 3
- [x] Bug 6 — run confirmation → Task 2
- [x] Bug 7 — fly.toml already done → noted in pre-flight
- [x] Guide: KPI card labels → Task 4
- [x] Guide: sidebar "Test Runs" / "Worklist" → Task 4
- [x] Guide: measure card order → Task 4
- [x] Guide: per-card vs. global driver table → Task 4
- [x] Guide: run timing cold-start → Task 4
- [x] Guide: card contents (remove last-run-timestamp) → Task 4

**Placeholder scan:** none found.

**Type consistency:** `TrendPoint` type is unchanged (`runId`, `startedAt`, `complianceRate`, `totalEvaluated`). `totalEvaluated` field is referenced in the new `filter((t) => t.totalEvaluated > 0)` — confirmed present in the type definition at line 33. No new types introduced.
