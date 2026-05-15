# Sprint 5 — Test Suite and CI Gates

**Sprint Goal:** The CI pipeline blocks merges when tests fail, a Playwright E2E golden path test verifies the end-to-end demo flow on every PR, and the frontend has meaningful unit test coverage for the three most critical UI flows.

**Effort estimate:** 4–5 developer days  
**Priority:** Medium  
**Prerequisite:** Sprint 0 bugs must be fixed so tests have a working baseline; Sprint 1 async runs must be complete so E2E can trigger a real run

---

## Issue 5.1 — Frontend Has No Unit Tests

### Current behavior
The frontend has zero Vitest or React Testing Library tests. `pnpm test` probably resolves to nothing or an error. There is no way to detect regressions automatically. The cases list, case detail actions, and Studio compile flow are the most complex frontend surfaces — they have received the most bug reports and would benefit most from test coverage.

### Desired behavior
Core behavioral unit tests covering:
1. **Auth flow** — `useAuth()` hook initializes from token, handles 401 propagation.
2. **Cases list** — renders rows, filter URL params update on change, "My Cases" tab shows correct subset.
3. **Case detail** — outreach action button calls the right API endpoint, timeline renders events in order.
4. **Studio compile** — CQL compile button calls `/api/measures/{id}/cql/compile`, shows error list on failure.
5. **SLA countdown** — `slaRemainingDays` prop renders correct color class and text.

Tests use Vitest + React Testing Library + `msw` (Mock Service Worker) for API mocking. No DOM snapshots — behavioral assertions only.

### Root cause
No test tooling configured. No tests written.

### Files to modify / create

- Create: `frontend/vitest.config.ts`
- Modify: `frontend/package.json` — add test script and dev dependencies
- Create: `frontend/__tests__/cases/CasesList.test.tsx`
- Create: `frontend/__tests__/cases/CaseDetail.test.tsx`
- Create: `frontend/__tests__/studio/CompileFlow.test.tsx`
- Create: `frontend/__tests__/auth/useAuth.test.ts`
- Create: `frontend/__tests__/components/SlaCountdown.test.tsx`
- Create: `frontend/test/msw/handlers.ts` — MSW request handlers for API mocking
- Create: `frontend/test/msw/server.ts` — MSW server setup

### Implementation steps

**Step 1: Install test dependencies**
```bash
cd frontend
pnpm add -D vitest @vitest/coverage-v8 @testing-library/react @testing-library/jest-dom @testing-library/user-event msw jsdom @vitejs/plugin-react
```

**Step 2: Create `vitest.config.ts`**
```typescript
// frontend/vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules', '.next', 'test'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
```

**Step 3: Create test setup file**
```typescript
// frontend/test/setup.ts
import '@testing-library/jest-dom';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './msw/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

**Step 4: Create MSW handlers**
```typescript
// frontend/test/msw/handlers.ts
import { http, HttpResponse } from 'msw';

export const handlers = [
  http.get('/api/cases', ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    return HttpResponse.json({
      content: [
        {
          id: 'case-001',
          employeeExternalId: 'EMP-001',
          employeeName: 'Jane Smith',
          measureName: 'Annual Audiogram',
          currentOutcomeStatus: 'OVERDUE',
          priority: 'HIGH',
          status: status ?? 'OPEN',
          assignee: 'cm@workwell.dev',
          slaRemainingDays: 5,
          slaBreached: false,
        },
      ],
      totalElements: 1,
      totalPages: 1,
    });
  }),

  http.get('/api/cases/:id', ({ params }) => {
    return HttpResponse.json({
      id: params.id,
      employeeName: 'Jane Smith',
      employeeExternalId: 'EMP-001',
      measureName: 'Annual Audiogram',
      currentOutcomeStatus: 'OVERDUE',
      priority: 'HIGH',
      status: 'OPEN',
      actions: [],
      auditEvents: [],
    });
  }),

  http.post('/api/cases/:id/actions/outreach', () => {
    return HttpResponse.json({ success: true });
  }),

  http.post('/api/measures/:id/cql/compile', () => {
    return HttpResponse.json({
      status: 'ERROR',
      issues: [
        { severity: 'error', message: 'Undefined identifier: In Hearing Program', line: 5, column: 12 }
      ],
    });
  }),
];
```

**Step 5: Create MSW server**
```typescript
// frontend/test/msw/server.ts
import { setupServer } from 'msw/node';
import { handlers } from './handlers';

export const server = setupServer(...handlers);
```

**Step 6: Write cases list test**
```typescript
// frontend/__tests__/cases/CasesList.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Minimal wrapper providing auth context and router
function renderWithProviders(ui: React.ReactElement) {
  // ... wrap with AuthProvider mock + Next.js router mock
}

describe('Cases list', () => {
  it('renders case rows from API response', async () => {
    renderWithProviders(<CasesPage />);
    await waitFor(() => {
      expect(screen.getByText('Jane Smith')).toBeInTheDocument();
      expect(screen.getByText('Annual Audiogram')).toBeInTheDocument();
    });
  });

  it('shows SLA countdown with correct urgency color', async () => {
    renderWithProviders(<CasesPage />);
    await waitFor(() => {
      const slaChip = screen.getByText('5d');
      // 5 days left → yellow class
      expect(slaChip).toHaveClass('text-yellow-600');
    });
  });

  it('shows "Breached" text when slaBreached=true', async () => {
    server.use(
      http.get('/api/cases', () =>
        HttpResponse.json({
          content: [{
            id: 'case-002', employeeName: 'Bob', measureName: 'TB', 
            currentOutcomeStatus: 'OVERDUE', priority: 'CRITICAL',
            status: 'OPEN', slaRemainingDays: -3, slaBreached: true,
          }],
          totalElements: 1, totalPages: 1,
        })
      )
    );
    renderWithProviders(<CasesPage />);
    await waitFor(() => {
      expect(screen.getByText('Breached')).toBeInTheDocument();
    });
  });
});
```

**Step 7: Write compile flow test**
```typescript
// frontend/__tests__/studio/CompileFlow.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

describe('Studio CQL compile flow', () => {
  it('shows compile error list when API returns errors', async () => {
    renderWithProviders(<CqlTab measureVersionId="mv-001" />);

    // Click compile button
    fireEvent.click(screen.getByRole('button', { name: /compile/i }));

    await waitFor(() => {
      expect(screen.getByText(/Undefined identifier/i)).toBeInTheDocument();
      expect(screen.getByText(/line 5/i)).toBeInTheDocument();
    });
  });

  it('shows success state when compile returns no issues', async () => {
    server.use(
      http.post('/api/measures/:id/cql/compile', () =>
        HttpResponse.json({ status: 'COMPILED', issues: [] })
      )
    );
    renderWithProviders(<CqlTab measureVersionId="mv-001" />);
    fireEvent.click(screen.getByRole('button', { name: /compile/i }));
    await waitFor(() => {
      expect(screen.getByText(/compiled/i)).toBeInTheDocument();
    });
  });
});
```

**Step 8: Add test script to `package.json`**
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

**Step 9: Run tests to verify baseline**
```bash
cd frontend && pnpm test
# Expected: all tests pass, no TypeScript errors
```

### Acceptance criteria
- [ ] `pnpm test` exits 0 from `frontend/` directory
- [ ] Cases list tests: renders rows, SLA colors, breached state
- [ ] Compile flow tests: error list displayed, success state displayed
- [ ] At least 1 auth hook test passes
- [ ] MSW intercepts API calls (no real network calls in tests)
- [ ] Coverage report generated (does not need to hit a threshold — just must generate)

---

## Issue 5.2 — Backend Integration Tests Are Incomplete

### Current behavior
The backend has some tests but key invariants are not asserted:
- Case idempotency (upsert constraint) may not have a dedicated test.
- Audit event publishing after case creation may not be tested.
- The SLA escalation job from Sprint 3 has no test.
- The evidence MIME validation from Sprint 4 has no test.

The existing test suite may use mocks where a real database is needed, risking the same mock/prod divergence that already caused one production bug (`CASE_SLA_BREACHED` → `CASE_SLA_BREACHED` vs `CASE_SLO_BREACHED` type string mismatch in payload).

### Desired behavior
Tests use TestContainers with a real PostgreSQL 16 container for all database-touching tests. Key invariants tested:
1. **Case idempotency:** Re-running the same employee+measure+period produces 0 new case rows.
2. **Audit completeness:** After a case transition, at least one `audit_event` row exists with the correct `event_type`.
3. **SLA escalation:** Injecting a case with `sla_due_date = NOW() - 1 day` and calling `escalateBreachedCases()` promotes priority and writes `CASE_SLA_BREACHED` audit event.
4. **Evidence validation:** Uploading a `.exe` returns HTTP 415; uploading a valid PDF returns 200.

### Files to modify / create

**Backend:**
- Modify: `backend/build.gradle.kts` — add TestContainers PostgreSQL and Spring Boot test dependencies
- Create: `backend/src/test/java/com/workwell/caseflow/CaseUpsertIntegrationTest.java`
- Create: `backend/src/test/java/com/workwell/caseflow/CaseSlaServiceTest.java`
- Create: `backend/src/test/java/com/workwell/web/EvidenceControllerTest.java`

### Implementation steps

**Step 1: Add TestContainers dependency**
```kotlin
// build.gradle.kts
testImplementation("org.testcontainers:postgresql:1.19.8")
testImplementation("org.testcontainers:junit-jupiter:1.19.8")
testImplementation("org.springframework.boot:spring-boot-testcontainers")
```

**Step 2: Create base integration test class**
```java
// backend/src/test/java/com/workwell/AbstractIntegrationTest.java
package com.workwell;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
public abstract class AbstractIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine")
        .withDatabaseName("workwell_test")
        .withUsername("test")
        .withPassword("test");

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        registry.add("spring.flyway.url", postgres::getJdbcUrl);
        registry.add("spring.flyway.user", postgres::getUsername);
        registry.add("spring.flyway.password", postgres::getPassword);
    }

    @LocalServerPort
    protected int port;
}
```

**Step 3: Case idempotency integration test**
```java
// backend/src/test/java/com/workwell/caseflow/CaseUpsertIntegrationTest.java
package com.workwell.caseflow;

import com.workwell.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class CaseUpsertIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    CaseUpsertService caseUpsertService;

    @Autowired
    JdbcClient jdbc;

    @Test
    void rerunProducesNoDuplicateCases() {
        // Arrange: seed minimum required rows
        UUID employeeId = seedTestEmployee();
        UUID measureVersionId = seedTestMeasureVersion();
        UUID runId1 = UUID.randomUUID();
        UUID runId2 = UUID.randomUUID();
        String evaluationPeriod = "2026-05-01";

        // Act: upsert twice with same key, different run IDs
        caseUpsertService.upsert(employeeId, measureVersionId, evaluationPeriod,
            "OVERDUE", runId1, Instant.now());
        caseUpsertService.upsert(employeeId, measureVersionId, evaluationPeriod,
            "OVERDUE", runId2, Instant.now());

        // Assert: exactly 1 case row
        int count = jdbc.sql("""
            SELECT COUNT(*) FROM cases
            WHERE employee_id = :empId
              AND measure_version_id = :mvId
              AND evaluation_period = :period
            """)
            .param("empId", employeeId)
            .param("mvId", measureVersionId)
            .param("period", evaluationPeriod)
            .query(Integer.class)
            .single();

        assertThat(count).isEqualTo(1);
    }

    @Test
    void compliantOutcomeClosesExistingCase() {
        UUID employeeId = seedTestEmployee();
        UUID measureVersionId = seedTestMeasureVersion();
        String period = "2026-05-02";

        caseUpsertService.upsert(employeeId, measureVersionId, period,
            "OVERDUE", UUID.randomUUID(), Instant.now());
        caseUpsertService.upsert(employeeId, measureVersionId, period,
            "COMPLIANT", UUID.randomUUID(), Instant.now());

        String status = jdbc.sql("SELECT status FROM cases WHERE employee_id=:e AND measure_version_id=:m AND evaluation_period=:p")
            .param("e", employeeId).param("m", measureVersionId).param("p", period)
            .query(String.class).single();

        assertThat(status).isEqualTo("RESOLVED");
    }

    private UUID seedTestEmployee() {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
            INSERT INTO employees (id, external_id, name, role, site, active)
            VALUES (:id, :extId, 'Test Employee', 'Nurse', 'Site A', true)
            """)
            .param("id", id)
            .param("extId", "TEST-" + id.toString().substring(0, 8))
            .update();
        return id;
    }

    private UUID seedTestMeasureVersion() {
        UUID measureId = UUID.randomUUID();
        UUID mvId = UUID.randomUUID();
        jdbc.sql("INSERT INTO measures (id, name, created_at, updated_at) VALUES (:id, 'Test Measure', NOW(), NOW())")
            .param("id", measureId).update();
        jdbc.sql("""
            INSERT INTO measure_versions (id, measure_id, version, status, spec_json, created_at)
            VALUES (:id, :mid, '1.0', 'ACTIVE', '{}'::jsonb, NOW())
            """)
            .param("id", mvId).param("mid", measureId).update();
        return mvId;
    }
}
```

**Step 4: SLA escalation test**
```java
// backend/src/test/java/com/workwell/caseflow/CaseSlaServiceTest.java
package com.workwell.caseflow;

import com.workwell.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class CaseSlaServiceTest extends AbstractIntegrationTest {

    @Autowired CaseSlaService slaService;
    @Autowired JdbcClient jdbc;

    @Test
    void breachedCaseGetsPriorityEscalatedAndAuditEventWritten() {
        // Seed a case with sla_due_date in the past
        UUID caseId = seedCaseWithPastSla("MEDIUM");

        slaService.escalateBreachedCases();

        String newPriority = jdbc.sql("SELECT priority FROM cases WHERE id = :id")
            .param("id", caseId).query(String.class).single();
        assertThat(newPriority).isEqualTo("HIGH");

        int auditCount = jdbc.sql("""
            SELECT COUNT(*) FROM audit_events
            WHERE event_type = 'CASE_SLA_BREACHED' AND ref_case_id = :id
            """)
            .param("id", caseId).query(Integer.class).single();
        assertThat(auditCount).isEqualTo(1);

        boolean breached = jdbc.sql("SELECT sla_breached FROM cases WHERE id = :id")
            .param("id", caseId).query(Boolean.class).single();
        assertThat(breached).isTrue();
    }

    private UUID seedCaseWithPastSla(String priority) {
        // ... seed minimal employee + measure version + case rows
        // Set sla_due_date = NOW() - INTERVAL '1 day'
        // Return case UUID
    }
}
```

**Step 5: Evidence validation test (MockMvc-based)**
```java
// backend/src/test/java/com/workwell/web/EvidenceControllerTest.java
package com.workwell.web;

import com.workwell.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@AutoConfigureMockMvc
class EvidenceControllerTest extends AbstractIntegrationTest {

    @Autowired MockMvc mockMvc;

    @Test
    void rejectsExecutableWithHttp415() throws Exception {
        // Magic bytes for Windows PE executable (MZ header)
        byte[] exeBytes = new byte[]{0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00};
        MockMultipartFile file = new MockMultipartFile("file", "malware.exe", "application/octet-stream", exeBytes);

        mockMvc.perform(multipart("/api/cases/{id}/evidence", seedCaseId())
                .file(file)
                .header("Authorization", "Bearer " + testToken("ROLE_CASE_MANAGER")))
            .andExpect(status().isUnsupportedMediaType())
            .andExpect(jsonPath("$.error").value("unsupported_media_type"));
    }

    @Test
    void acceptsValidPdf() throws Exception {
        byte[] pdfBytes = "%PDF-1.4 test".getBytes(); // Minimal PDF magic bytes
        MockMultipartFile file = new MockMultipartFile("file", "evidence.pdf", "application/pdf", pdfBytes);

        mockMvc.perform(multipart("/api/cases/{id}/evidence", seedCaseId())
                .file(file)
                .header("Authorization", "Bearer " + testToken("ROLE_CASE_MANAGER")))
            .andExpect(status().isOk());
    }
}
```

### Acceptance criteria
- [ ] `./gradlew test` passes with TestContainers spinning up a real PostgreSQL 16 instance
- [ ] Case idempotency test asserts exactly 1 row after two upserts with the same key
- [ ] COMPLIANT outcome closes existing case (status = RESOLVED)
- [ ] SLA escalation test verifies priority promotion and audit event creation
- [ ] Evidence validation test rejects executable, accepts PDF

---

## Issue 5.3 — CI Pipeline Does Not Gate on Tests

### Current behavior
The current CI workflow (`.github/workflows/ci.yml`) runs the backend build and frontend lint but does not run backend tests, frontend tests, or block PRs from merging when tests fail. A broken test can be committed and merged silently.

### Desired behavior
CI pipeline on every PR and push to `main`:
1. Backend: `./gradlew test` — must pass.
2. Frontend: `pnpm test` — must pass.
3. Frontend: `pnpm build` — must pass.
4. Frontend: `pnpm lint` — must pass.
5. All four checks must be green before a PR can be merged (enforced via GitHub branch protection rules).
6. Test results are published as a JUnit XML report visible in the GitHub Actions UI.

### Files to modify / create

- Modify: `.github/workflows/ci.yml`

### Implementation steps

**Step 1: Update the CI workflow**
```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, 'claude/**', 'fix/**', 'feat/**']
  pull_request:
    branches: [main]

jobs:
  backend:
    name: Backend — Test
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: workwell_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK 21
        uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'

      - name: Cache Gradle
        uses: actions/cache@v4
        with:
          path: |
            ~/.gradle/caches
            ~/.gradle/wrapper
          key: ${{ runner.os }}-gradle-${{ hashFiles('backend/**/*.gradle.kts', 'backend/gradle/wrapper/gradle-wrapper.properties') }}
          restore-keys: |
            ${{ runner.os }}-gradle-

      - name: Run backend tests
        working-directory: backend
        env:
          SPRING_DATASOURCE_URL: jdbc:postgresql://localhost:5432/workwell_test
          SPRING_DATASOURCE_USERNAME: test
          SPRING_DATASOURCE_PASSWORD: test
          SPRING_PROFILES_ACTIVE: test
          WORKWELL_AUTH_ENABLED: false
          ANTHROPIC_API_KEY: test-key-not-real
        run: ./gradlew test --parallel

      - name: Publish test results
        uses: dorny/test-reporter@v1
        if: always()
        with:
          name: Backend Tests
          path: backend/build/test-results/test/*.xml
          reporter: java-junit

  frontend:
    name: Frontend — Lint, Test, Build
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
          cache-dependency-path: frontend/pnpm-lock.yaml

      - name: Install dependencies
        working-directory: frontend
        run: pnpm install --frozen-lockfile

      - name: Lint
        working-directory: frontend
        run: pnpm lint

      - name: Unit tests
        working-directory: frontend
        run: pnpm test

      - name: Build
        working-directory: frontend
        env:
          NEXT_PUBLIC_API_BASE_URL: https://workwell-measure-studio-api.fly.dev
          NEXT_PUBLIC_APP_NAME: WorkWell Measure Studio
          NEXT_PUBLIC_DEMO_MODE: false
        run: pnpm build
```

**Step 2: Enable branch protection on GitHub**

In the repository settings:
- Branch: `main`
- Require status checks to pass before merging: `backend` and `frontend`
- Require branches to be up to date before merging: enabled
- Require pull request reviews: 1 (optional for solo dev, but good practice)

This cannot be done via a file — it must be set in GitHub repository settings.

**Step 3: Verify test parallelism is configured in backend**
```kotlin
// build.gradle.kts — add parallel test forks if not already present
tasks.test {
    useJUnitPlatform()
    maxParallelForks = (Runtime.getRuntime().availableProcessors() / 2).coerceAtLeast(1)
    reports.junitXml.required.set(true)
}
```

### Acceptance criteria
- [ ] CI runs on every push to `main` and every PR
- [ ] `./gradlew test` runs in CI with a real PostgreSQL service container
- [ ] `pnpm test` runs in CI and fails the CI job if any test fails
- [ ] `pnpm build` runs in CI
- [ ] Test results are published and visible in GitHub Actions UI
- [ ] A PR with a failing test cannot be merged (branch protection rules set)

---

## Issue 5.4 — No Playwright End-to-End Tests for the Golden Demo Path

### Current behavior
No E2E tests exist. The only way to verify the demo flow works end-to-end is to manually test it before every deploy. This is time-consuming and error-prone — the `/programs/overview` bug that caused a 500 on a named route was not caught before it hit production.

### Desired behavior
A Playwright test file that verifies the golden demo path:
1. Login with demo credentials
2. Navigate to `/programs` and verify KPI cards load
3. Click the Audiogram program card and verify trend chart renders
4. Navigate to `/runs`, trigger a manual run for ALL_PROGRAMS, wait for completion
5. Navigate to `/cases`, verify at least one case row appears
6. Click a case row, verify the case detail page renders with the "Why Flagged" section
7. Navigate to `/studio` measure list, click a measure, verify the Studio page loads with tabs
8. Logout and verify redirect to `/login`

The test runs against the deployed Vercel + Fly.io stack in a separate CI job that is triggered manually (not on every PR — it's expensive).

### Files to modify / create

- Create: `e2e/playwright.config.ts`
- Create: `e2e/tests/golden-path.spec.ts`
- Create: `e2e/package.json`
- Modify: `.github/workflows/ci.yml` — add optional E2E job triggered manually

### Implementation steps

**Step 1: Initialize Playwright project**
```bash
mkdir e2e && cd e2e
pnpm init
pnpm add -D @playwright/test
npx playwright install chromium
```

**Step 2: Create `playwright.config.ts`**
```typescript
// e2e/playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 1,
  workers: 1,  // serial to avoid race conditions on shared demo data
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'https://workwell-measure-studio.vercel.app',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
```

**Step 3: Write the golden path test**
```typescript
// e2e/tests/golden-path.spec.ts
import { test, expect } from '@playwright/test';

const DEMO_EMAIL = 'cm@workwell.dev';
const DEMO_PASSWORD = 'Workwell123!';

test.describe('Golden demo path', () => {

  test('full demo flow: login → programs → runs → cases → studio → logout', async ({ page }) => {

    // 1. Login
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(DEMO_EMAIL);
    await page.getByLabel(/password/i).fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page).toHaveURL(/\/programs/);
    await expect(page.getByText(/compliance/i)).toBeVisible();

    // 2. Programs overview — KPI cards
    await expect(page.locator('[data-testid="program-card"]').first()).toBeVisible();

    // 3. Click Audiogram program card
    await page.getByText(/audiogram/i).first().click();
    await expect(page).toHaveURL(/\/programs\//);
    // Trend chart should render (recharts SVG)
    await expect(page.locator('svg.recharts-surface')).toBeVisible();

    // 4. Navigate to runs, trigger a run
    await page.goto('/runs');
    await page.getByRole('button', { name: /run all programs/i }).click();

    // Wait for run status to appear
    await expect(page.getByText(/running|completed/i)).toBeVisible({ timeout: 30_000 });

    // 5. Navigate to cases
    await page.goto('/cases');
    await expect(page.locator('table tbody tr').first()).toBeVisible();

    // 6. Open case detail
    await page.locator('table tbody tr').first().click();
    await expect(page).toHaveURL(/\/cases\//);
    await expect(page.getByText(/why flagged/i)).toBeVisible();

    // 7. Navigate to Studio
    await page.goto('/measures');
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await page.locator('table tbody tr').first().click();
    await expect(page).toHaveURL(/\/studio\//);
    await expect(page.getByRole('tab', { name: /spec/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /cql/i })).toBeVisible();

    // 8. Logout
    await page.getByRole('button', { name: /logout|sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test('programs overview does not 500', async ({ page }) => {
    await loginAs(page, DEMO_EMAIL, DEMO_PASSWORD);
    const response = await page.goto('/programs');
    expect(response?.status()).toBe(200);
    await expect(page.locator('text=500')).not.toBeVisible();
    await expect(page.locator('text=Error')).not.toBeVisible();
  });

  test('employee profile page loads', async ({ page }) => {
    await loginAs(page, DEMO_EMAIL, DEMO_PASSWORD);
    // Navigate to cases list, click first employee name
    await page.goto('/cases');
    await page.locator('a[href^="/employees/"]').first().click();
    await expect(page).toHaveURL(/\/employees\//);
    await expect(page.getByText(/compliance posture/i)).toBeVisible();
  });
});

async function loginAs(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/programs/);
}
```

**Step 4: Add optional E2E job to CI**
```yaml
# Add to .github/workflows/ci.yml:
  e2e:
    name: Playwright E2E (manual)
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch'  # Manual trigger only

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - name: Install dependencies
        working-directory: e2e
        run: pnpm install
      - name: Install Playwright browsers
        working-directory: e2e
        run: npx playwright install chromium --with-deps
      - name: Run E2E tests
        working-directory: e2e
        env:
          PLAYWRIGHT_BASE_URL: https://workwell-measure-studio.vercel.app
        run: npx playwright test
      - name: Upload test report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: e2e/playwright-report/
```

**Step 5: Add `workflow_dispatch` trigger to CI**
```yaml
on:
  push:
    branches: [main, 'claude/**', 'fix/**', 'feat/**']
  pull_request:
    branches: [main]
  workflow_dispatch:  # Add this to allow manual E2E trigger
```

### Acceptance criteria
- [ ] `npx playwright test` runs against deployed URL and all 3 tests pass
- [ ] `/programs/overview` 500 test catches the existing bug (or passes after Sprint 0 fix)
- [ ] Screenshots are captured on failure and uploaded as CI artifacts
- [ ] E2E job is triggered manually via GitHub Actions "Run workflow" button
- [ ] E2E test login uses the same demo credentials as DEMO_SCRIPT.md

---

## Definition of Done — Sprint 5

- [ ] `pnpm test` in `frontend/` exits 0 with at least 5 passing behavioral tests
- [ ] `./gradlew test` in `backend/` exits 0 with TestContainers-backed integration tests
- [ ] Case idempotency invariant is tested with a real database
- [ ] SLA escalation and audit event are tested with a real database
- [ ] Evidence MIME validation rejects executables in tests
- [ ] CI pipeline runs backend tests, frontend tests, frontend lint, and frontend build on every PR
- [ ] A PR with a failing test cannot be merged (branch protection configured)
- [ ] Playwright golden path test passes against the deployed staging URL
- [ ] JOURNAL.md entry added

### Recommendations

**Test data isolation:** Integration tests that share a database must clean up after themselves or use a transaction rollback approach. Annotate each test class with `@Transactional` and Spring's test transaction management to roll back after each test — this is much faster than truncating tables between tests.

**Coverage thresholds:** Don't set a coverage threshold in Sprint 5. Coverage thresholds that are too low are security theater; thresholds that are too high block PRs for the wrong reasons. Instead, add coverage reporting to CI and review the report as part of PR review. Set a threshold after you've established a baseline (Sprint 6 or 7).

**Playwright vs. Cypress:** Playwright is the right choice here. It's faster, has better async handling, and the `@playwright/test` runner integrates well with GitHub Actions artifacts. Don't switch to Cypress unless you have a specific reason.

**Seed data stability:** Playwright E2E tests depend on the demo seed data being stable. If a previous E2E run created cases that were resolved, the cases list might be empty. Add a `beforeAll` step that calls `POST /api/admin/seed/reset` (if such an endpoint exists or is added in Sprint 6) to restore demo data to a known state before E2E runs.
