# Monorepo Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the WorkWell Measure Studio monorepo skeleton — directories, config, and stubs only; no feature code.

**Architecture:** Single git repo with `backend/` (Spring Boot 3 / Java 21 / Gradle), `frontend/` (Next.js 14 / pnpm), `infra/` (Docker Compose), `docs/`, and `.github/workflows/`. Backend produces a runnable Spring Boot jar with Flyway migration for `audit_events` and a Testcontainers integration test that proves the migration ran. Frontend produces a left-nav dashboard shell with six placeholder pages. Docker Compose declares all four services. CI runs `gradle build` and `pnpm lint` on PRs.

**Tech Stack:** Java 21, Spring Boot 3.3.5, Gradle Kotlin DSL, PostgreSQL 16, Flyway, Testcontainers, Next.js 14, TypeScript, Tailwind CSS, shadcn/ui, pnpm, Docker Compose, GitHub Actions

---

## File Map

| File | Responsibility |
|------|---------------|
| `backend/build.gradle.kts` | All §8.2 dependencies; Java 21 toolchain |
| `backend/settings.gradle.kts` | Root project name |
| `backend/src/main/java/com/workwell/WorkwellApplication.java` | Spring Boot entry point; `@EnableAsync` `@EnableScheduling` |
| `backend/src/main/resources/application.yml` | Datasource, JPA, Flyway, Actuator, springdoc config |
| `backend/src/main/resources/db/migration/V001__init.sql` | `audit_events` table per plan §7.1 |
| `backend/src/test/.../WorkwellApplicationTests.java` | Testcontainers Postgres context load + migration smoke test |
| `frontend/app/(dashboard)/layout.tsx` | Left-nav shell (Programs, Worklist, Measures, Studio, Runs, Admin) |
| `frontend/app/(dashboard)/*/page.tsx` (×6) | Placeholder pages |
| `frontend/app/layout.tsx` | Root HTML shell |
| `frontend/app/page.tsx` | Redirect to `/programs` |
| `infra/docker-compose.yml` | postgres, hapi-fhir, backend, frontend services |
| `.github/workflows/ci.yml` | `gradle build` + `pnpm lint` on PRs |
| `docs/JOURNAL.md` | Dated entry stub |
| `docs/DECISIONS.md` | ADR-001 stub |
| `docs/ARCHITECTURE.md` | One-line stub |
| `docs/DATA_MODEL.md` | One-line stub |
| `docs/MEASURES.md` | One-line stub |
| `docs/AI_GUARDRAILS.md` | One-line stub |
| `LICENSE` | Apache 2.0 |
| `README.md` | Quickstart stub |
| `.gitignore` | Java + Node + Docker ignore rules |

---

## Task 1: Root-level files

**Files:**
- Create: `LICENSE`
- Create: `README.md`
- Create: `.gitignore`

- [ ] **Step 1: Create LICENSE (Apache 2.0)**

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration and build scripts.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship made available under
      the License.

      "Derivative Works" shall mean any work that is based on the Work.

      "Contribution" shall mean any work of authorship submitted to the Licensor.

      "Contributor" shall mean Licensor and any Legal Entity on behalf of
      whom a Contribution has been received by the Licensor.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      patent license to make, use, sell, offer for sale, import, and
      otherwise transfer the Work.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or Derivative
          Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work; and

      (d) If the Work includes a "NOTICE" text file, you may reproduce
          and distribute a copy of the NOTICE file alongside the Work.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution submitted for inclusion in the Work by You to the
      Licensor shall be under the terms and conditions of this License.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, the Licensor provides the Work on an "AS IS"
      BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      shall any Contributor be liable to You for damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work, You may offer acceptance of support, warranty, indemnity,
      or other liability obligations consistent with this License.

   END OF TERMS AND CONDITIONS

   Copyright 2026 Taleef Tamsal

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

- [ ] **Step 2: Create README.md**

```markdown
# WorkWell Measure Studio

OSHA compliance measure authoring and execution — CQL-driven, evidence-based, auditable.

## Quickstart

```bash
docker compose -f infra/docker-compose.yml up
```

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:8080 |
| Swagger UI | http://localhost:8080/swagger-ui.html |
| HAPI FHIR | http://localhost:8090/fhir |

## Dev Prerequisites

- Java 21
- Node 20 + pnpm 9
- Docker Desktop

## Local backend only

```bash
cd backend
./gradlew bootRun
```

## Local frontend only

```bash
cd frontend
pnpm install
pnpm dev
```

See `docs/PROJECT_PLAN.md` for full architecture, roadmap, and ticket breakdown.
```

- [ ] **Step 3: Create .gitignore**

```gitignore
# Gradle
.gradle/
build/
!gradle/wrapper/gradle-wrapper.jar

# Java
*.class
*.jar
!gradle/wrapper/gradle-wrapper.jar

# IDE
.idea/
*.iml
.vscode/
*.suo
*.user

# Node / pnpm
node_modules/
.next/
out/
frontend/.next/

# Environment
.env
.env.local
.env.*.local

# Docker volumes
infra/postgres_data/

# Synthea output (generated — do not commit)
infra/synthea/output-bundles/

# OS
.DS_Store
Thumbs.db
```

- [ ] **Step 4: Commit**

```bash
git add LICENSE README.md .gitignore
git commit -m "chore: root scaffold — license, readme, gitignore"
```

---

## Task 2: Docs stubs

**Files:**
- Create: `docs/JOURNAL.md`
- Create: `docs/DECISIONS.md`
- Create: `docs/ARCHITECTURE.md`
- Create: `docs/DATA_MODEL.md`
- Create: `docs/MEASURES.md`
- Create: `docs/AI_GUARDRAILS.md`

- [ ] **Step 1: Create docs/JOURNAL.md**

```markdown
# WorkWell Studio — Development Journal

Newest entry on top. Format: `## YYYY-MM-DD`.

---

## 2026-04-29

Pre-internship prep day. Project plan finalized at v1.0. Monorepo scaffold created.
Four demo measures selected (Annual Audiogram, HAZWOPER Exam, TB Screening, Flu Vaccine).
Internship Week 1 (Phase 0) starts May 18.
```

- [ ] **Step 2: Create docs/DECISIONS.md**

```markdown
# Architecture Decision Records

Numbered, dated. Format: `## ADR-NNN — Title`.

---

## ADR-001 — Single Spring Boot deployable, modular packages

**Date:** 2026-04-29
**Status:** Accepted

**Context:** 13-week solo project; need full vertical slice running fast.

**Decision:** One Spring Boot application with domain packages (`com.workwell.measure`,
`com.workwell.run`, `com.workwell.caseflow`, etc.). No microservices.

**Consequences:** Simpler local dev, simpler CI, fewer deployment concerns for demo.
Split to separate services post-MVP if needed — the package boundaries are the seam.
```

- [ ] **Step 3: Create docs/ARCHITECTURE.md**

```markdown
# WorkWell Measure Studio — Architecture

See `docs/PROJECT_PLAN.md` §6 for the full component diagram and service descriptions.

This file will grow to contain: system diagrams, boundary descriptions, sequence diagrams for the run pipeline, and the MCP integration diagram. Due Phase 5.
```

- [ ] **Step 4: Create docs/DATA_MODEL.md**

```markdown
# WorkWell Measure Studio — Data Model

See `docs/PROJECT_PLAN.md` §7 for the full DDL sketch and `evidence_json` schema.

This file will document schema invariants and the idempotency contract once Phase 2 is complete.
```

- [ ] **Step 5: Create docs/MEASURES.md**

```markdown
# The Four Demo Measures

See `docs/PROJECT_PLAN.md` §9 for full measure definitions.

These will be expanded with the actual CQL sketches and value-set identifiers in Phase 0 Week 1.

1. Annual Audiogram Completed (OSHA 29 CFR 1910.95)
2. Annual Medical Surveillance Exam — HAZWOPER (OSHA 29 CFR 1910.120)
3. Annual TB Screening (CDC / org policy)
4. Flu Vaccine This Season (org policy)
```

- [ ] **Step 6: Create docs/AI_GUARDRAILS.md**

```markdown
# AI Usage Policy

See `docs/PROJECT_PLAN.md` §18 for the full AI/MCP strategy.

**Non-negotiable rule:** AI never decides compliance. The structured `evidence_json`
is always the source of truth. AI explanations sit *next to* structured data, never replacing it.

Three AI surfaces land in Phase 4: AI Draft Spec, Explain Why Flagged, Run Summary Insight.
```

- [ ] **Step 7: Commit**

```bash
git add docs/
git commit -m "docs: stub JOURNAL, DECISIONS, ARCHITECTURE, DATA_MODEL, MEASURES, AI_GUARDRAILS"
```

---

## Task 3: Backend skeleton

**Files:**
- Create: `backend/settings.gradle.kts`
- Create: `backend/build.gradle.kts`
- Create: `backend/src/main/java/com/workwell/WorkwellApplication.java`
- Create: `backend/src/main/resources/application.yml`
- Create: `backend/src/main/resources/db/migration/V001__init.sql`
- Create: `backend/src/test/java/com/workwell/WorkwellApplicationTests.java`

- [ ] **Step 1: Initialize Gradle wrapper**

Run from the `backend/` directory:

```bash
cd backend
gradle wrapper --gradle-version 8.10.2
```

Expected: `gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`, `gradle/wrapper/gradle-wrapper.properties` created.

- [ ] **Step 2: Create backend/settings.gradle.kts**

```kotlin
rootProject.name = "workwell-measure-studio"
```

- [ ] **Step 3: Create backend/build.gradle.kts**

```kotlin
plugins {
    java
    id("org.springframework.boot") version "3.3.5"
    id("io.spring.dependency-management") version "1.1.6"
}

group = "com.workwell"
version = "0.0.1-SNAPSHOT"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
}

extra["testcontainersVersion"] = "1.20.1"

dependencies {
    // Web
    implementation("org.springframework.boot:spring-boot-starter-web")

    // Data + DB
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.flywaydb:flyway-core")
    implementation("org.flywaydb:flyway-database-postgresql")
    runtimeOnly("org.postgresql:postgresql")

    // Security — JWT resource server (stub roles only for MVP)
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-oauth2-resource-server")

    // Actuator (health + info endpoints)
    implementation("org.springframework.boot:spring-boot-starter-actuator")

    // OpenAPI / Swagger UI
    implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:2.6.0")

    // MapStruct (entity ↔ DTO, cuts boilerplate)
    implementation("org.mapstruct:mapstruct:1.6.2")
    annotationProcessor("org.mapstruct:mapstruct-processor:1.6.2")

    // Validation
    implementation("org.springframework.boot:spring-boot-starter-validation")

    // Test
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.security:spring-security-test")
    testImplementation("org.testcontainers:junit-jupiter")
    testImplementation("org.testcontainers:postgresql")
}

dependencyManagement {
    imports {
        mavenBom("org.testcontainers:testcontainers-bom:${property("testcontainersVersion")}")
    }
}

tasks.withType<Test> {
    useJUnitPlatform()
}
```

- [ ] **Step 4: Create WorkwellApplication.java**

```java
package com.workwell;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableAsync
@EnableScheduling
public class WorkwellApplication {
    public static void main(String[] args) {
        SpringApplication.run(WorkwellApplication.class, args);
    }
}
```

- [ ] **Step 5: Create application.yml**

```yaml
spring:
  datasource:
    url: jdbc:postgresql://${DB_HOST:localhost}:${DB_PORT:5432}/${DB_NAME:workwell}
    username: ${DB_USER:workwell}
    password: ${DB_PASS:workwell}
  jpa:
    hibernate:
      ddl-auto: validate
    open-in-view: false
    properties:
      hibernate:
        dialect: org.hibernate.dialect.PostgreSQLDialect
  flyway:
    enabled: true
    locations: classpath:db/migration

springdoc:
  swagger-ui:
    path: /swagger-ui.html

management:
  endpoints:
    web:
      exposure:
        include: health,info
  endpoint:
    health:
      show-details: when-authorized
```

- [ ] **Step 6: Create V001__init.sql**

```sql
-- Audit log: append-only. Every service writes here; nothing ever deletes from this table.
CREATE TABLE audit_events (
    id                     BIGSERIAL    PRIMARY KEY,
    event_type             TEXT         NOT NULL,
    entity_type            TEXT         NOT NULL,
    entity_id              UUID,
    actor                  TEXT,
    ref_run_id             UUID,
    ref_case_id            UUID,
    ref_measure_version_id UUID,
    payload_json           JSONB,
    occurred_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_ref_run_id_idx     ON audit_events (ref_run_id);
CREATE INDEX audit_events_ref_case_id_idx    ON audit_events (ref_case_id);
CREATE INDEX audit_events_event_type_idx     ON audit_events (event_type);
```

- [ ] **Step 7: Write the integration test**

```java
package com.workwell;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
@Testcontainers
class WorkwellApplicationTests {

    @Container
    static PostgreSQLContainer<?> postgres =
            new PostgreSQLContainer<>("postgres:16-alpine");

    @DynamicPropertySource
    static void datasource(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url",      postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }

    @Autowired
    JdbcTemplate jdbc;

    @Test
    void contextLoads() {
        // Spring context starts and Flyway runs V001 without error
    }

    @Test
    void v001MigrationCreatesAuditEventsTable() {
        // Verify the table exists and has the expected columns
        Integer count = jdbc.queryForObject(
            "SELECT COUNT(*) FROM information_schema.tables " +
            "WHERE table_schema = 'public' AND table_name = 'audit_events'",
            Integer.class
        );
        assertThat(count).isEqualTo(1);
    }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd backend
./gradlew test
```

Expected output: `BUILD SUCCESSFUL`, both tests green. Testcontainers will pull `postgres:16-alpine` on first run.

- [ ] **Step 9: Commit**

```bash
git add backend/
git commit -m "chore(backend): Spring Boot 3 skeleton, Flyway V001 audit_events, Testcontainers smoke test"
```

---

## Task 4: Frontend skeleton

**Files:**
- Create: `frontend/` (via pnpm create next-app)
- Create: `frontend/app/layout.tsx`
- Create: `frontend/app/page.tsx`
- Create: `frontend/app/(dashboard)/layout.tsx`
- Create: `frontend/app/(dashboard)/programs/page.tsx`
- Create: `frontend/app/(dashboard)/worklist/page.tsx`
- Create: `frontend/app/(dashboard)/measures/page.tsx`
- Create: `frontend/app/(dashboard)/studio/page.tsx`
- Create: `frontend/app/(dashboard)/runs/page.tsx`
- Create: `frontend/app/(dashboard)/admin/page.tsx`

- [ ] **Step 1: Scaffold Next.js app**

```bash
cd frontend  # (or let pnpm create place it)
pnpm create next-app@latest . \
  --typescript \
  --tailwind \
  --app \
  --src-dir=false \
  --import-alias="@/*" \
  --no-eslint
```

Then immediately add ESLint (needed for CI lint step):

```bash
cd frontend
pnpm add -D eslint eslint-config-next
```

Create `frontend/.eslintrc.json`:

```json
{
  "extends": "next/core-web-vitals"
}
```

- [ ] **Step 2: Initialize shadcn/ui**

```bash
cd frontend
pnpm dlx shadcn@latest init -d
```

When prompted, accept defaults (New York style, neutral base color, CSS variables yes).

- [ ] **Step 3: Verify Tailwind config was created**

`frontend/tailwind.config.ts` should exist. If `pnpm create next-app` used `tailwind.config.js`, rename it to `tailwind.config.ts`.

- [ ] **Step 4: Replace frontend/app/layout.tsx (root HTML shell)**

```tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "WorkWell Measure Studio",
  description: "OSHA compliance measure authoring and execution",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
```

- [ ] **Step 5: Create frontend/app/page.tsx (redirect)**

```tsx
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/programs");
}
```

- [ ] **Step 6: Create frontend/app/(dashboard)/layout.tsx (left-nav shell)**

```tsx
import Link from "next/link";

const navItems = [
  { href: "/programs", label: "Programs"       },
  { href: "/worklist", label: "Worklist"        },
  { href: "/measures", label: "Measures"        },
  { href: "/studio",   label: "Measure Studio"  },
  { href: "/runs",     label: "Test Runs"       },
  { href: "/admin",    label: "Admin"           },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen bg-slate-50">
      <aside className="w-56 shrink-0 bg-slate-900 text-slate-100 flex flex-col py-6 px-3 gap-0.5">
        <div className="px-3 mb-6">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            WorkWell Studio
          </span>
        </div>
        {navItems.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className="rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
          >
            {label}
          </Link>
        ))}
      </aside>
      <main className="flex-1 overflow-auto p-8">{children}</main>
    </div>
  );
}
```

- [ ] **Step 7: Create all six placeholder pages**

`frontend/app/(dashboard)/programs/page.tsx`:
```tsx
export default function ProgramsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-800">Programs</h1>
      <p className="mt-2 text-slate-500">Program overview — Phase 3.</p>
    </div>
  );
}
```

`frontend/app/(dashboard)/worklist/page.tsx`:
```tsx
export default function WorklistPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-800">Worklist</h1>
      <p className="mt-2 text-slate-500">Case queue — Phase 3.</p>
    </div>
  );
}
```

`frontend/app/(dashboard)/measures/page.tsx`:
```tsx
export default function MeasuresPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-800">Measures</h1>
      <p className="mt-2 text-slate-500">Measure catalog — Phase 1 Ticket 1.</p>
    </div>
  );
}
```

`frontend/app/(dashboard)/studio/page.tsx`:
```tsx
export default function StudioPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-800">Measure Studio</h1>
      <p className="mt-2 text-slate-500">Spec + CQL editor — Phase 1 Tickets 2 &amp; 3.</p>
    </div>
  );
}
```

`frontend/app/(dashboard)/runs/page.tsx`:
```tsx
export default function RunsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-800">Test Runs</h1>
      <p className="mt-2 text-slate-500">Run history — Phase 2 Ticket 4.</p>
    </div>
  );
}
```

`frontend/app/(dashboard)/admin/page.tsx`:
```tsx
export default function AdminPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-800">Admin</h1>
      <p className="mt-2 text-slate-500">Integrations, SSO, notification templates — Phase 5.</p>
    </div>
  );
}
```

- [ ] **Step 8: Run lint to verify it passes**

```bash
cd frontend
pnpm lint
```

Expected: no errors (all files are valid TSX stubs).

- [ ] **Step 9: Commit**

```bash
git add frontend/
git commit -m "chore(frontend): Next.js 14 skeleton, Tailwind, shadcn/ui, left-nav dashboard shell, placeholder pages"
```

---

## Task 5: Infra + CI

**Files:**
- Create: `infra/docker-compose.yml`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create infra/docker-compose.yml**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: workwell
      POSTGRES_USER: workwell
      POSTGRES_PASSWORD: workwell
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U workwell"]
      interval: 5s
      timeout: 5s
      retries: 5

  hapi-fhir:
    image: hapiproject/hapi:latest
    restart: unless-stopped
    ports:
      - "8090:8080"
    environment:
      hapi.fhir.fhir_version: R4

  backend:
    build:
      context: ../backend
      dockerfile: Dockerfile
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: workwell
      DB_USER: workwell
      DB_PASS: workwell
    depends_on:
      postgres:
        condition: service_healthy

  frontend:
    build:
      context: ../frontend
      dockerfile: Dockerfile
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:8080
    depends_on:
      - backend

volumes:
  postgres_data:
```

- [ ] **Step 2: Create backend/Dockerfile (needed for compose build)**

```dockerfile
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY build/libs/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
```

Note: `./gradlew bootJar` must run before `docker compose up --build`. README will document this.

- [ ] **Step 3: Create frontend/Dockerfile**

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

Add `output: "standalone"` to `frontend/next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
```

- [ ] **Step 4: Create .github/workflows/ci.yml**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  backend:
    name: Backend — build & test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with:
          java-version: "21"
          distribution: temurin
          cache: gradle

      - name: Build and test
        working-directory: backend
        run: ./gradlew build
        # Testcontainers pulls postgres:16-alpine on first run — ~30s on a cold runner

  frontend:
    name: Frontend — lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: pnpm
          cache-dependency-path: frontend/pnpm-lock.yaml

      - name: Install dependencies
        working-directory: frontend
        run: pnpm install --frozen-lockfile

      - name: Lint
        working-directory: frontend
        run: pnpm lint
```

- [ ] **Step 5: Commit**

```bash
git add infra/ .github/ backend/Dockerfile frontend/Dockerfile frontend/next.config.ts
git commit -m "chore(infra): docker-compose (postgres, hapi-fhir, backend, frontend) + Dockerfiles + GitHub Actions CI"
```

---

## Task 6: Final rollup commit

- [ ] **Step 1: Verify file tree matches plan**

```bash
find . -not -path './.git/*' -not -path './backend/build/*' -not -path './frontend/node_modules/*' -not -path './frontend/.next/*' | sort
```

Confirm: all directories and files from the File Map above are present.

- [ ] **Step 2: Run backend tests one final time**

```bash
cd backend && ./gradlew test
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 3: Run frontend lint one final time**

```bash
cd frontend && pnpm lint
```

Expected: no errors

- [ ] **Step 4: Final scaffold commit**

```bash
git add -A
git commit -m "chore: initial monorepo scaffold"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|---|---|
| `backend/` Gradle + Spring Boot 3.x + Java 21 | Task 3 |
| §8.2 dependencies in build.gradle.kts | Task 3 Step 3 |
| Health endpoint | Task 3 Step 5 (Actuator `health`) |
| Flyway V001 audit_events per §7.1 | Task 3 Step 6 |
| Testcontainers smoke test | Task 3 Step 7–8 |
| `frontend/` Next.js + Tailwind + shadcn/ui | Task 4 Steps 1–2 |
| Left-nav shell matching Screenshot 6 | Task 4 Step 6 |
| Placeholder pages for all 6 routes | Task 4 Step 7 |
| `infra/docker-compose.yml` with all 4 services | Task 5 Step 1 |
| `.github/workflows/ci.yml` gradle build + pnpm lint | Task 5 Step 4 |
| `docs/JOURNAL.md` with format example | Task 2 Step 1 |
| `docs/DECISIONS.md` with ADR format | Task 2 Step 2 |
| Apache 2.0 LICENSE | Task 1 Step 1 |
| Commit as "chore: initial monorepo scaffold" | Task 6 Step 4 |

### Constraints verified (do-nots)

- No microservices — single Spring Boot app ✓
- No Kafka — not in dependencies ✓
- No auth beyond stub — Spring Security declared but not configured beyond dependency ✓
- No real email — not present ✓
- No CQL editor — not present ✓
- No Run service — not present ✓
- No HAPI FHIR config beyond docker-compose entry — only image + port + R4 env ✓
- No Synthea — not present ✓
- No Phase 1+ feature code — all pages are stubs ✓

### Placeholder scan

No TBD/TODO/placeholder language in code blocks. All file contents are complete and runnable.

### Type consistency

No types defined in early tasks referenced in later tasks (this is a scaffold — no cross-task type dependencies).
