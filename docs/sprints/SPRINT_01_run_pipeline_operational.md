# Sprint 1 — Run Pipeline & Operational Correctness

> **For agentic workers:** Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to implement task-by-task.

**Goal:** Transform the run pipeline from a synchronous HTTP-blocking operation into a durable, async, schedulable system that can handle real operational workloads without timeouts, with proper pagination and scoped execution.

**Branch:** `feat/sprint-1-run-pipeline`

**Prerequisites:** Sprint 0 complete (demo polish). The run engine core works correctly — this sprint hardens the execution model around it.

**Estimated effort:** 4–5 days

**Tech additions needed:**
- Spring `@Async` + `ThreadPoolTaskExecutor` (already in Spring Boot — no new dependency)
- Frontend polling with `useEffect` + `setInterval`

---

## Issue 1.1 — Runs Execute Synchronously, Blocking the HTTP Thread

### Current Behavior
`POST /api/runs/manual` executes the entire run synchronously inside the HTTP request thread. A full all-programs run over 400 employees takes 2–5 minutes. During this time:
- The HTTP connection is held open until completion
- The Fly.io proxy may time out (30-second default) and return an error to the client
- The client receives no progress feedback
- If the Fly machine is under load, the single thread executing the run blocks all other requests

**Evidence:** The post-merge status doc notes "Impact preview → ⏱ Slow/timeout (heavy computation over all employees)". The demo script says to click "Run All Measures Now" and wait — the UI provides no feedback during this wait.

### Desired Behavior
`POST /api/runs/manual` returns **immediately** (< 200ms) with:
```json
{ "runId": "uuid", "status": "REQUESTED", "message": "Run queued for execution" }
```

The run executes asynchronously in a background thread. The frontend polls `GET /api/runs/{runId}` every 5 seconds until `status` is `COMPLETED` or `FAILED`. The Programs Overview auto-refreshes when the polling completes.

### Root Cause
`AllProgramsRunService.executeRun()` is called directly in the controller within the same HTTP request. It was designed for simplicity during the spike, not for production throughput.

### Files to Modify

**Backend:**
- `backend/src/main/java/com/workwell/web/EvalController.java` — change to async dispatch, return immediately
- `backend/src/main/java/com/workwell/run/AllProgramsRunService.java` — annotate async method
- `backend/src/main/java/com/workwell/config/AsyncConfig.java` — create (thread pool config)
- `backend/src/main/resources/application.yml` — thread pool settings

**Frontend:**
- `frontend/app/(dashboard)/programs/page.tsx` — add polling after triggering run
- `frontend/app/(dashboard)/runs/page.tsx` — show in-progress run with live status badge

### Implementation Steps

**Step 1: Create `AsyncConfig.java` to configure the thread pool**
```java
// backend/src/main/java/com/workwell/config/AsyncConfig.java
package com.workwell.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import java.util.concurrent.Executor;

@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean(name = "runExecutor")
    public Executor runExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(2);
        executor.setMaxPoolSize(4);
        executor.setQueueCapacity(20);
        executor.setThreadNamePrefix("workwell-run-");
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(120);
        executor.initialize();
        return executor;
    }
}
```

**Step 2: Add `@Async` to the run service execution method**

In `AllProgramsRunService.java`, wrap the actual execution in an async method:
```java
// In AllProgramsRunService.java
import org.springframework.scheduling.annotation.Async;

@Async("runExecutor")
public void executeRunAsync(UUID runId, ManualRunRequest request, String actor) {
    try {
        // Mark as RUNNING
        runPersistenceService.updateRunStatus(runId, "RUNNING");
        // ... existing execution logic ...
        runPersistenceService.updateRunStatus(runId, "COMPLETED");
    } catch (Exception e) {
        log.error("Run {} failed: {}", runId, e.getMessage(), e);
        runPersistenceService.updateRunStatus(runId, "FAILED");
        runPersistenceService.setFailureSummary(runId, e.getMessage());
    }
}
```

**Step 3: Update `RunPersistenceService` to support status updates**

Add a method to update run status without rewriting the entire run row:
```java
// In RunPersistenceService.java
@Transactional
public void updateRunStatus(UUID runId, String status) {
    jdbcTemplate.update(
        "UPDATE runs SET status = ?, completed_at = CASE WHEN ? IN ('COMPLETED','FAILED','CANCELLED') THEN NOW() ELSE completed_at END WHERE id = ?",
        status, status, runId
    );
}

@Transactional
public void setFailureSummary(UUID runId, String summary) {
    jdbcTemplate.update(
        "UPDATE runs SET failure_summary = ? WHERE id = ?",
        summary, runId
    );
}
```

**Step 4: Update `EvalController.java` to return immediately**
```java
// In EvalController.java — manualRun endpoint
@PostMapping("/api/runs/manual")
@PreAuthorize("hasAnyAuthority('ROLE_ADMIN','ROLE_CASE_MANAGER','ROLE_AUTHOR')")
public ResponseEntity<Map<String, Object>> manualRun(
        @RequestBody ManualRunRequest request,
        Authentication auth) {

    String actor = auth.getName();

    // Create the run record with REQUESTED status — returns immediately
    UUID runId = allProgramsRunService.createRunRecord(request, actor);

    // Dispatch async execution — does not block
    allProgramsRunService.executeRunAsync(runId, request, actor);

    return ResponseEntity.accepted().body(Map.of(
        "runId", runId,
        "status", "REQUESTED",
        "message", "Run queued for execution. Poll GET /api/runs/" + runId + " for status."
    ));
}
```

**Step 5: Update `AllProgramsRunService.createRunRecord()` to return runId**

Extract the run record creation into its own synchronous method that persists the run with `REQUESTED` status and returns the UUID:
```java
@Transactional
public UUID createRunRecord(ManualRunRequest request, String actor) {
    UUID runId = UUID.randomUUID();
    jdbcTemplate.update(
        """
        INSERT INTO runs (id, scope_type, scope_id, trigger_type, status, triggered_by,
                         started_at, measurement_period_start, measurement_period_end,
                         requested_scope_json, dry_run)
        VALUES (?, ?, ?, 'MANUAL', 'REQUESTED', ?, NOW(), ?, ?, ?::jsonb, ?)
        """,
        runId,
        request.scopeType().name(),
        request.measureId(),
        actor,
        request.measurementPeriodStart(),
        request.measurementPeriodEnd(),
        objectMapper.writeValueAsString(request),
        request.dryRun()
    );
    return runId;
}
```

**Step 6: Add run status polling endpoint (if not existing)**

`GET /api/runs/{runId}` already exists and returns the full run record including `status`. Confirm it returns `status` as a field. No new endpoint needed.

**Step 7: Add frontend polling in programs page**

In `frontend/app/(dashboard)/programs/page.tsx`, after triggering "Run All Measures Now":
```tsx
const [activeRunId, setActiveRunId] = useState<string | null>(null)
const [runStatus, setRunStatus] = useState<string | null>(null)

async function handleRunAll() {
  const result = await api.post<{}, { runId: string; status: string }>(
    '/api/runs/manual',
    { scopeType: 'ALL_PROGRAMS' }
  )
  setActiveRunId(result.runId)
  setRunStatus('REQUESTED')
  toast.success('Run started — refreshing when complete')
}

// Polling effect
useEffect(() => {
  if (!activeRunId || runStatus === 'COMPLETED' || runStatus === 'FAILED') return
  
  const interval = setInterval(async () => {
    try {
      const run = await api.get<{ status: string }>(`/api/runs/${activeRunId}`)
      setRunStatus(run.status)
      if (run.status === 'COMPLETED') {
        clearInterval(interval)
        setActiveRunId(null)
        // Refresh program data
        refreshPrograms()
        toast.success('Run completed — programs updated')
      } else if (run.status === 'FAILED') {
        clearInterval(interval)
        setActiveRunId(null)
        toast.error('Run failed — check run logs for details')
      }
    } catch { /* ignore transient errors */ }
  }, 5000)
  
  return () => clearInterval(interval)
}, [activeRunId, runStatus])
```

**Step 8: Show in-progress indicator on programs page**
```tsx
{activeRunId && (
  <div className="flex items-center gap-2 text-sm text-muted-foreground">
    <Loader2 className="h-4 w-4 animate-spin" />
    <span>Run in progress ({runStatus?.toLowerCase().replace('_', ' ')})...</span>
  </div>
)}
```

**Step 9: Write a test for the async dispatch**
```java
// In RunControllerTest.java — add test:
@Test
void manualRunReturnsImmediatelyWithRequestedStatus() throws Exception {
    mockMvc.perform(post("/api/runs/manual")
            .with(jwt().authorities(new SimpleGrantedAuthority("ROLE_CASE_MANAGER")))
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"scopeType\":\"ALL_PROGRAMS\"}"))
        .andExpect(status().isAccepted())
        .andExpect(jsonPath("$.status").value("REQUESTED"))
        .andExpect(jsonPath("$.runId").isNotEmpty());
}
```

**Step 10: Commit**
```bash
git add backend/src/main/java/com/workwell/config/AsyncConfig.java
git add backend/src/main/java/com/workwell/run/
git add backend/src/main/java/com/workwell/web/EvalController.java
git add frontend/app/(dashboard)/programs/page.tsx
git commit -m "feat(runs): async run execution — returns REQUESTED immediately, polls to COMPLETED"
```

### Acceptance Criteria
- [ ] `POST /api/runs/manual` returns HTTP 202 in < 500ms
- [ ] Response contains `{ runId, status: "REQUESTED" }`
- [ ] Run appears in run history with status "REQUESTED" then transitions to "RUNNING" then "COMPLETED"
- [ ] Frontend shows a spinner during the run and refreshes programs on completion
- [ ] Toast notification on run completion or failure
- [ ] Fly proxy does not time out during a full all-programs run
- [ ] Run failure is persisted with `failure_summary` and does not crash the server

---

## Issue 1.2 — Scheduled Runs Are Disabled in Production

### Current Behavior
The `ScheduledRunService` class exists but the scheduler is **disabled** in production. The admin page shows `"disabled"` for the scheduler with no configured cron expression. The product's core value proposition — "run measures automatically so you don't live in spreadsheets" — is not delivered because nothing actually runs automatically.

**Evidence:** Admin page screenshot shows scheduler as `"disabled"`, cron is blank, last run is "Never".

### Desired Behavior
A default daily scheduled run executes automatically at a configurable time (default: 2:00 AM UTC). The admin page shows the next scheduled run time. An admin can enable/disable the scheduler and change the cron expression. When the scheduled run completes, audit events are written with `triggerType = "SCHEDULED"`.

### Root Cause
`ScheduledRunService` likely uses Spring's `@Scheduled` annotation but is either not `@EnableScheduling` on the main app or the scheduler is disabled via a config flag. The run service infrastructure changes from Issue 1.1 (async execution) must be completed first so scheduled runs also run asynchronously.

### Files to Modify
- `backend/src/main/java/com/workwell/run/ScheduledRunService.java` — wire async execution
- `backend/src/main/java/com/workwell/config/AsyncConfig.java` — enable scheduling
- `backend/src/main/resources/application.yml` — add default cron config
- `backend/src/main/java/com/workwell/web/AdminController.java` — scheduler enable/disable endpoint

### Implementation Steps

**Step 1: Add `@EnableScheduling` to `AsyncConfig.java`**
```java
// In AsyncConfig.java — add:
@Configuration
@EnableAsync
@EnableScheduling  // <-- add this
public class AsyncConfig { ... }
```

**Step 2: Configure the default cron in `application.yml`**
```yaml
# application.yml
workwell:
  scheduler:
    enabled: true
    cron: "0 0 2 * * *"  # 2:00 AM UTC daily
```

**Step 3: Update `ScheduledRunService.java`**
```java
// ScheduledRunService.java
@Service
@Slf4j
public class ScheduledRunService {

    private final AllProgramsRunService runService;
    private final ApplicationContext applicationContext;

    @Value("${workwell.scheduler.enabled:true}")
    private boolean schedulerEnabled;

    @Scheduled(cron = "${workwell.scheduler.cron:0 0 2 * * *}")
    public void runScheduledMeasures() {
        if (!schedulerEnabled) {
            log.info("Scheduler disabled — skipping scheduled run");
            return;
        }
        log.info("Scheduler: triggering daily all-programs run");
        ManualRunRequest request = new ManualRunRequest(
            RunScopeType.ALL_PROGRAMS, null, null, null, null,
            LocalDate.now().minusYears(1).atStartOfDay(),
            LocalDate.now().atStartOfDay(),
            false
        );
        UUID runId = runService.createRunRecord(request, "scheduler");
        runService.executeRunAsync(runId, request, "scheduler");
    }
}
```

**Step 4: Update admin scheduler endpoint to persist enabled/disabled state**

The scheduler enable/disable should write to `integration_health` table (or a dedicated `scheduler_config` table) so state survives restarts:
```java
// In AdminController.java — scheduler endpoint
@PostMapping("/api/admin/scheduler")
@PreAuthorize("hasAuthority('ROLE_ADMIN')")
public ResponseEntity<Map<String, Object>> updateScheduler(
        @RequestBody Map<String, Object> body) {
    boolean enabled = (Boolean) body.getOrDefault("enabled", true);
    String cron = (String) body.getOrDefault("cron", "0 0 2 * * *");
    
    schedulerAdminService.updateSchedulerConfig(enabled, cron);
    
    return ResponseEntity.ok(Map.of(
        "enabled", enabled,
        "cron", cron,
        "nextFire", schedulerAdminService.calculateNextFire(cron)
    ));
}
```

**Step 5: Show next scheduled run time in admin page**

In `frontend/app/(dashboard)/admin/page.tsx`, after fetching scheduler config, display:
```tsx
<div className="text-sm">
  <span className="text-muted-foreground">Next scheduled run: </span>
  <span className="font-medium">
    {schedulerConfig.nextFire
      ? new Date(schedulerConfig.nextFire).toLocaleString()
      : 'Not scheduled'}
  </span>
</div>
```

**Step 6: Commit**
```bash
git commit -m "feat(scheduler): enable daily scheduled runs at 2AM UTC with admin toggle"
```

### Acceptance Criteria
- [ ] Scheduler runs automatically at 2:00 AM UTC daily (verify via logs)
- [ ] Admin page shows scheduler as "enabled" with next fire time
- [ ] Admin can disable/re-enable scheduler via the admin UI
- [ ] Scheduled runs appear in run history with `triggerType = "Scheduled"`
- [ ] Audit events contain `actor = "scheduler"` for scheduled runs
- [ ] Scheduler respects the `workwell.scheduler.enabled` config flag

---

## Issue 1.3 — SITE and EMPLOYEE Scoped Runs Return 400 (Not Implemented)

### Current Behavior
`POST /api/runs/manual` with `scopeType: "SITE"` or `scopeType: "EMPLOYEE"` returns HTTP 400 with a message like "Unsupported scope type". These scope types are documented in the API contract and expected to work.

**Evidence:** POST_MERGE_STATUS.md: "SITE and EMPLOYEE scoped runs remain deferred (not implemented; 400 returned for unsupported scopes)."

### Desired Behavior
- `SITE` scope: Runs all active measures for all employees at a specific site. Requires `site` field in request.
- `EMPLOYEE` scope: Runs all active measures for a single employee. Requires `employeeExternalId` in request.
- Both scope types follow the same async execution model from Issue 1.1.

### Root Cause
`AllProgramsRunService` only handles `ALL_PROGRAMS`, `MEASURE`, and `CASE` scope types. The switch/if chain has no branch for `SITE` or `EMPLOYEE` and falls to the 400 error.

### Files to Modify
- `backend/src/main/java/com/workwell/run/AllProgramsRunService.java` — add SITE and EMPLOYEE branches
- `backend/src/main/java/com/workwell/run/RunScopeType.java` — confirm SITE and EMPLOYEE are defined
- `backend/src/test/java/com/workwell/run/ScopedRunIntegrationTest.java` — add tests

### Implementation Steps

**Step 1: Confirm `RunScopeType` enum contains SITE and EMPLOYEE**
```java
// RunScopeType.java
public enum RunScopeType {
    ALL_PROGRAMS,
    MEASURE,
    SITE,      // should already exist
    EMPLOYEE,  // should already exist
    CASE
}
```

**Step 2: Add employee resolution methods**
```java
// In AllProgramsRunService.java — add helper:
private List<Employee> resolveEmployeesForScope(ManualRunRequest request) {
    return switch (request.scopeType()) {
        case ALL_PROGRAMS -> employeeRepository.findAllActive();
        case MEASURE -> employeeRepository.findAllActive(); // measure filter applied during eval
        case SITE -> {
            if (request.site() == null || request.site().isBlank())
                throw new IllegalArgumentException("SITE scope requires 'site' field");
            yield employeeRepository.findBySiteActive(request.site());
        }
        case EMPLOYEE -> {
            if (request.employeeExternalId() == null)
                throw new IllegalArgumentException("EMPLOYEE scope requires 'employeeExternalId'");
            Employee emp = employeeRepository.findByExternalId(request.employeeExternalId())
                .orElseThrow(() -> new IllegalArgumentException(
                    "Employee not found: " + request.employeeExternalId()));
            yield List.of(emp);
        }
        case CASE -> resolveCaseEmployee(request.caseId());
    };
}
```

**Step 3: Update `executeRunAsync()` to use `resolveEmployeesForScope()`**
```java
@Async("runExecutor")
public void executeRunAsync(UUID runId, ManualRunRequest request, String actor) {
    try {
        runPersistenceService.updateRunStatus(runId, "RUNNING");
        List<Employee> employees = resolveEmployeesForScope(request);
        List<MeasureVersion> measures = resolveMeasuresForScope(request);

        // Run CQL evaluation for each employee × measure combination
        for (MeasureVersion measure : measures) {
            for (Employee employee : employees) {
                evaluateAndPersist(runId, employee, measure, request);
            }
        }

        runPersistenceService.finalizeRun(runId);
        runPersistenceService.updateRunStatus(runId, "COMPLETED");
    } catch (IllegalArgumentException e) {
        runPersistenceService.updateRunStatus(runId, "FAILED");
        runPersistenceService.setFailureSummary(runId, e.getMessage());
    } catch (Exception e) {
        log.error("Run {} failed unexpectedly", runId, e);
        runPersistenceService.updateRunStatus(runId, "FAILED");
        runPersistenceService.setFailureSummary(runId, "Internal error: " + e.getMessage());
    }
}
```

**Step 4: Add SQL query methods to employee repository**
```java
// EmployeeRepository or in AllProgramsRunService via jdbcTemplate:
public List<Employee> findBySiteActive(String site) {
    return jdbcTemplate.query(
        "SELECT * FROM employees WHERE site = ? AND active = true",
        employeeRowMapper, site
    );
}
```

**Step 5: Write integration tests**
```java
// ScopedRunIntegrationTest.java — add:
@Test
void siteScope_returnsOnlyEmployeesFromRequestedSite() {
    // Given: employees at "Clinic" and "Plant A"
    // When: SITE scope run for "Clinic"
    // Then: outcomes only for Clinic employees
}

@Test
void employeeScope_returnsSingleEmployee() {
    // When: EMPLOYEE scope run for "emp-001"
    // Then: exactly 4 outcomes (one per active measure) for emp-001
}

@Test
void siteScope_withoutSiteField_returns400() {
    // POST { scopeType: "SITE" } without site field
    // Should return 400 with clear error message
}
```

**Step 6: Commit**
```bash
git commit -m "feat(runs): implement SITE and EMPLOYEE scoped runs"
```

### Acceptance Criteria
- [ ] `POST /api/runs/manual` with `scopeType: "SITE", site: "Clinic"` returns 202 and runs only Clinic employees
- [ ] `POST /api/runs/manual` with `scopeType: "EMPLOYEE", employeeExternalId: "emp-006"` returns 202 and evaluates only that employee across all active measures
- [ ] Missing required field returns 400 with clear error message
- [ ] Integration tests pass for both scope types
- [ ] Run history shows correct `scopeType` and employee/outcome counts

---

## Issue 1.4 — Programs Overview Does Not Auto-Refresh After Run Completes

### Current Behavior
After triggering "Run All Measures Now", the Programs Overview page does not update its KPI cards, measure cards, or trend data to reflect the new run results. The user must manually navigate away and back (or do a full page reload) to see updated compliance numbers.

### Desired Behavior
After the async run polling (from Issue 1.1) detects `status === "COMPLETED"`, the programs page automatically re-fetches and re-renders the programs data without a full page reload. KPI cards and measure cards show the updated compliance numbers with a brief animation.

### Files to Modify
- `frontend/app/(dashboard)/programs/page.tsx` — add `refreshPrograms()` trigger after polling completes

### Implementation Steps

**Step 1: Extract the programs data fetch into a callable function**
```tsx
// In programs/page.tsx
const [programs, setPrograms] = useState<Program[]>([])
const [overview, setOverview] = useState<ProgramOverview | null>(null)

const fetchPrograms = useCallback(async () => {
  const [progs, over] = await Promise.all([
    api.get<Program[]>('/api/programs'),
    api.get<ProgramOverview>('/api/programs/overview'),
  ])
  setPrograms(progs)
  setOverview(over)
}, [api])

// Call on mount
useEffect(() => { fetchPrograms() }, [fetchPrograms])

// Call after run completes (from polling effect in Issue 1.1)
function refreshPrograms() {
  fetchPrograms()
}
```

**Step 2: Animate the KPI card numbers on refresh**

Add a brief "pulse" animation when numbers update:
```tsx
// Add a key that changes on refresh to trigger remount animation
<div key={overview?.lastRunAt} className="animate-pulse-once">
  <span className="text-3xl font-bold">{overview?.overallCompliance}%</span>
</div>
```

Or use a simple CSS transition on the number:
```css
/* globals.css */
@keyframes numberRefresh {
  0% { opacity: 0.4; }
  100% { opacity: 1; }
}
.refreshed { animation: numberRefresh 0.5s ease; }
```

**Step 3: Commit**
```bash
git commit -m "feat(programs): auto-refresh overview data when run completes"
```

### Acceptance Criteria
- [ ] After triggering a run, programs page shows spinner during execution
- [ ] When run completes, KPI cards update without manual reload
- [ ] Updated numbers show with a brief visual cue (pulse/animation)

---

## Issue 1.5 — Cases List Has No Pagination or Filtering Persistence

### Current Behavior
`GET /api/cases` returns all cases. With 151 open cases, the cases list is a very long scroll. Filter state (status, measure, assignee) resets every time the page is navigated away from and back to. The URL does not reflect the current filter state, so filters can't be bookmarked or shared.

### Desired Behavior
- Cases list shows 25 cases by default with load-more pagination
- Filter state is persisted in the URL query string (`/cases?status=open&priority=HIGH`)
- Browser back/forward preserves filter state

### Files to Modify
- `frontend/app/(dashboard)/cases/page.tsx` — add URL-based filter state, pagination
- `backend/src/main/java/com/workwell/web/CaseController.java` — confirm `limit` and `offset` parameters are supported

### Implementation Steps

**Step 1: Confirm backend supports limit/offset**
```java
// CaseController.java — getCases endpoint should accept:
@GetMapping("/api/cases")
public List<CaseDto> getCases(
    @RequestParam(required = false) String status,
    @RequestParam(required = false) String measureId,
    @RequestParam(required = false) String priority,
    @RequestParam(required = false) String assignee,
    @RequestParam(required = false) String site,
    @RequestParam(defaultValue = "25") int limit,
    @RequestParam(defaultValue = "0") int offset
)
```

If `limit` and `offset` are not already supported, add them to the SQL query:
```sql
SELECT c.*, e.name as employee_name, e.external_id as employee_external_id,
       m.name as measure_name, mv.version as measure_version
FROM cases c
JOIN employees e ON c.employee_id = e.id
JOIN measure_versions mv ON c.measure_version_id = mv.id
JOIN measures m ON mv.measure_id = m.id
WHERE (? IS NULL OR c.status = ?)
  AND (? IS NULL OR mv.measure_id = ?::uuid)
  AND (? IS NULL OR c.priority = ?)
ORDER BY c.updated_at DESC
LIMIT ? OFFSET ?
```

**Step 2: Use URL search params for filter state in frontend**
```tsx
// frontend/app/(dashboard)/cases/page.tsx
import { useSearchParams, useRouter } from 'next/navigation'

const searchParams = useSearchParams()
const router = useRouter()

const status = searchParams.get('status') ?? 'open'
const priority = searchParams.get('priority') ?? ''
const [page, setPage] = useState(0)

function updateFilter(key: string, value: string) {
  const params = new URLSearchParams(searchParams.toString())
  if (value) params.set(key, value)
  else params.delete(key)
  params.delete('page') // reset to page 0 on filter change
  router.push(`/cases?${params.toString()}`)
}
```

**Step 3: Add "Load more" button**
```tsx
const [cases, setCases] = useState<Case[]>([])
const [hasMore, setHasMore] = useState(true)

async function loadMore() {
  const next = await api.get<Case[]>(
    `/api/cases?status=${status}&limit=25&offset=${cases.length}`
  )
  setCases(prev => [...prev, ...next])
  setHasMore(next.length === 25)
}

{hasMore && (
  <Button variant="outline" onClick={loadMore}>
    Load more cases
  </Button>
)}
```

**Step 4: Commit**
```bash
git commit -m "feat(cases): URL-based filter persistence and load-more pagination"
```

### Acceptance Criteria
- [ ] Cases list initially shows ≤ 25 cases
- [ ] "Load more" appends the next 25 cases
- [ ] Filter selections are reflected in the URL (`?status=open&priority=HIGH`)
- [ ] Navigating back restores the filter state
- [ ] Browser bookmark of a filtered URL loads the correct filtered state

---

## Sprint 1 Definition of Done

- [ ] `POST /api/runs/manual` returns HTTP 202 in < 500ms with `runId` and `status: "REQUESTED"`
- [ ] Frontend polls run status and shows real-time progress indicator
- [ ] Programs Overview auto-refreshes when run completes
- [ ] Scheduler executes daily at 2:00 AM UTC (verify via Fly logs after midnight)
- [ ] Admin page shows scheduler enabled with next fire time
- [ ] SITE scoped run evaluates only the employees at the specified site
- [ ] EMPLOYEE scoped run evaluates only the specified employee across all measures
- [ ] Cases list is paginated (25 per page) with URL-persisted filters
- [ ] Runs list is paginated (20 per page with load-more)
- [ ] All new behavior covered by integration tests
- [ ] Deployed and verified on Fly + Vercel

**Branch to merge:** `feat/sprint-1-run-pipeline`
**PR title:** `feat: Sprint 1 — async run execution, scheduler activation, scoped runs, pagination`
