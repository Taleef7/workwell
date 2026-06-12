# Refactor memo — `@mieweb/cloud` as the pluggable backend (response to #96)

Date: 2026-06-10 (status updated 2026-06-12)
Author: Taleef (drafted with Claude Code)
Status: **Accepted — companion analysis to ADR-008.** The direction in this memo is now committed; see
ADR-008 in `docs/DECISIONS.md` for the decision of record and
`docs/superpowers/plans/2026-06-12-issue-96-dejava-replatform.md` for the phased execution plan + GitHub
board (#96 sub-issues #102–#109). Path C (Node-ELM execution) is the **preferred** implementation of the
`EvaluateMeasure` compute binding this memo describes; the JVM evaluator sidecar is the fallback impl,
decided by the Phase-1 parity spike (#103). This memo remains the detailed source for the 9-question
answers, the repo-grounded Spring footprint, and the `*Store` contract shapes.
Scope: smallest refactor that satisfies "Java/Spring Boot must not be required to use, test, or deploy `@mieweb/cloud`," answering Doug's 9 questions.

---

## TL;DR (the one honest tension up front)

There are **two layers** in this repo, and #96 should treat them differently:

1. **The application/framework layer** — HTTP routing, persistence, auth, queues, outreach, dashboards, MCP, AI surfaces. This is ~16 Spring modules. **This can and should move to worker-compatible TypeScript on `@mieweb/cloud` contracts.** No CQL/FHIR semantics live here.

2. **The compliance engine** — CQL → ELM translation + `cqf-fhir-cr` measure evaluation against a FHIR bundle. This is **JVM-only** with no production-grade TypeScript equivalent today. cqf-fhir-cr, HAPI FHIR, and the CQL-to-ELM translator are Java. (MITRE's `cql-execution`/`cql-exec-fhir` exist in JS but do **not** translate CQL→ELM and do not replicate cqf measure-population semantics.)

So the achievable end state is **not** "no JVM anywhere." It is:

> **No JVM in the portability layer.** The CQL engine becomes an explicit **compute binding** — a service the worker calls (like an AI provider or vector backend), not the application framework. Cloudflare-shaped contract on top; JVM evaluator behind one named binding; "no TS-native CQL engine yet" surfaced honestly as `UnsupportedBindingError` until/unless a transpile path (E9 / #78) is decided.

The good news, already true in the repo today: **E1/E2 already cut this seam.** The evaluation core is Spring-free except for cosmetic annotations, and we already ship a no-Spring, no-DB headless entrypoint that proves it.

---

## Grounding evidence (what's actually in the repo, 2026-06-10)

- **Spring footprint:** 295 `org.springframework` imports across 69 files in `backend/src/main/java`. Deep coupling = `spring-boot-starter-{web,data-jpa,security,validation,actuator}`, `spring-ai-openai`, `mcp-spring-webmvc` (`build.gradle.kts:31-43`).
- **The engine seam is already isolated (E1, PR #95 / E2, PR #98):**
  - `engine.port` — 4 pure interfaces, **zero** Spring imports: `PatientDataProvider`, `EmployeeDirectory`, `MeasureDefinitionProvider`, `EvaluationConfigProvider`.
  - `engine.model` — `MeasureDefinition`, `BundleOutcome` — pure Java.
  - `CqlEvaluationService` (`compile/`) — **one** Spring import, `@Service`. Exposes public `evaluateBundle(...)`.
  - `engine.synthetic.*` — only `@Component`. `engine.yaml.YamlMeasureDefinitionProvider` — `@Component` + Spring resource-loading helpers (replaceable with `java.nio` + classpath scan).
  - `engine.cli.HeadlessEvaluatorCli` — plain `main`, only `ClassPathResource`. Runs with **no `ApplicationContext`, no DB**.
  - Guard tests already enforce this: `EngineNoSpringContextTest` (core evaluates with no context) and `EngineGoldenParityTest` (100 employees × 10 measures byte-identical through the YAML provider).

**Implication:** the hard part Doug is worried about (Spring DI permeating the core) is already not true for the engine. The engine is a callable function. The refactor is about the *other* 16 modules.

---

## Answers to Doug's 9 questions

### 1. Where Spring Boot dependencies currently enter the repo
Single Gradle module `backend/`. Entry points, by weight:
- **Web/MVC:** `web/*Controller` (REST), `mcp-spring-webmvc` (MCP transport), springdoc.
- **Persistence:** `spring-boot-starter-data-jpa` + Flyway (`run/`, `caseflow/`, `audit/`, `measure/`, `admin/`, `export/`).
- **Security:** `spring-boot-starter-security` (`security/`, `config/SecurityConfig`, JWT filters).
- **AI:** `spring-ai-openai-spring-boot-starter` (`ai/`).
- **Cross-cutting:** `config/` (`@Configuration`, async, rate-limit, CORS), `@Scheduled` in `run/ScheduledRunService`, `admin/`.
- **Engine:** cosmetic only (`@Service`/`@Component`) — see above.

### 2. Which parts can be removed/replaced immediately
- **Engine core** needs no removal — drop the 6 cosmetic annotations and construct it explicitly (E2's CLI already does exactly this). It is "done" for portability.
- **CSV export, AI prompt assembly, outreach templating, audit packet assembly** are mostly pure transforms over data — portable to TS with low risk once they read from a `*Store` contract instead of JPA repositories.

### 3. Which parts need temporary compatibility shims
- **The CQL engine** is a *permanent* binding, not a temporary shim: expose `CqlEvaluationService.evaluateBundle(...)` over a thin transport (stdio for local/CLI, HTTP for server, or a sidecar worker). This is the only Java that survives in the steady state.
- **MCP server** (`mcp-spring-webmvc`) — shim until re-implemented on the TS MCP SDK.
- **JPA → contract** — the `*Store` interfaces (below) are the shim boundary; the JPA implementations stay as the `@mieweb/cloud-postgres`-equivalent until the TS adapters reach parity, then retire.

### 4. Replacing Spring DI with explicit adapter construction
Already demonstrated: `HeadlessEvaluatorCli` builds `new CqlEvaluationService(patientProvider, employeeDir, measureProvider, configProvider)` by hand — no container. Generalize that pattern: a single composition root per target constructs stores + engine binding explicitly. The 4 `engine.port` interfaces are the template for the storage ports.

### 5. Supporting SQLite, D1, and Postgres through one storage contract
Define explicit repository contracts (Doug's exact shape) per aggregate — `RunStore`, `CaseStore`, `OutcomeStore`, `MeasureStore`, `AuditStore`:
```ts
await runStore.createRun(input);
await runStore.appendLog(runId, chunk);
await runStore.claimNextQueuedRun(workerId); // PG: FOR UPDATE SKIP LOCKED; SQLite/D1: UPDATE…RETURNING
```
**SQLite/D1 define the portable floor; Postgres is the performance ceiling.** Use Drizzle/Kysely for schema + migrations + CRUD; keep locking, queue-claiming, JSON-heavy and bulk queries in adapter-specific code (the ORM is *not* the portability layer). Our current schema (`docs/DATA_MODEL.md`) is already JSON-column + simple-join shaped, so the SQLite floor is realistic — the one place to watch is `jsonb_exists`/Postgres JSON operators (already a documented JDBC pitfall), which must degrade to a portable predicate on the floor.

### 6. How migrations run per target
One migration source of truth (Drizzle migrations) generating dialect-appropriate SQL; Postgres keeps Flyway only until the Postgres adapter owns its migrations. **Schema remains Taleef-owned (CLAUDE.md hard rule)** — the refactor proposes the contract; migration authoring stays gated to the maintainer.

### 7. How the mieweb CLI selects the backend target
`@mieweb/cli`-style launcher picks the target via flag/env (`--target cloudflare|local|postgres|os`), constructs the matching composition root, and selects the CQL binding (in-process JVM sidecar vs. remote evaluator endpoint). Cloudflare = native bindings, zero overhead; everything else = explicit adapter set.

### 8. Contract tests required before a backend is "supported"
Reuse the discipline E2 already established. A backend is "supported" only when:
- The `@mieweb/test-app` contract suite passes against its adapters (CRUD + queue-claim + transaction semantics).
- **Golden parity** holds: same patient bundle + measure YAML → byte-identical outcome+evidence as the reference, mirroring `EngineGoldenParityTest`. This is the non-negotiable gate, because compliance correctness is the product.
- Unsupported operations raise `UnsupportedBindingError`, not silent fallback.

### 9. How unsupported features are surfaced honestly
Explicit `UnsupportedBindingError` from `@mieweb/cloud-types` (Doug's design). No faking. Concretely: a target with no CQL binding configured must **refuse to evaluate**, not return a guessed status — this is the same invariant as our existing "AI never decides compliance; CQL `Outcome Status` is the sole source of truth" rule, carried into the portability layer.

---

## Smallest refactor plan (sequenced, reversible)

1. **Lock the engine as a binding (smallest, highest leverage).** Promote E2's headless evaluator into a stable `EvaluateMeasure` service contract (stdio + HTTP). Strip the 6 cosmetic annotations from `engine.*`/`CqlEvaluationService`. No behavior change; golden-parity gated. → This alone satisfies "the JVM is a binding, not the framework."
2. **Define `@mieweb/cloud-types` storage contracts** (`RunStore`, `CaseStore`, `OutcomeStore`, `MeasureStore`, `AuditStore`) + `UnsupportedBindingError`, modeled on the 4 existing `engine.port` interfaces.
3. **Stand up `@mieweb/cloud-local`** (SQLite + filesystem + in-proc queue) and a contract test app. Wire it to call the engine binding from step 1. Prove one measure end-to-end with no JVM in the app path (JVM only behind the evaluate binding).
4. **`@mieweb/cloud-postgres`** implementing the same contracts against current Neon schema (migration ownership stays with Taleef).
5. **Port application surfaces** (runs, cases, exports, outreach, audit) onto the contracts incrementally; retire the Spring module as each surface reaches parity. Keep Spring app runnable as the reference until the TS path passes the full contract + golden suites.
6. **Decide E9/#78 (CQL→SQL) separately.** Only that epic can remove the JVM binding entirely; until then it stays, surfaced honestly.

**Net:** Cloudflare stays native and zero-overhead; every other backend is pluggable; Java/Spring is **not required** to use/test/deploy the portability layer; the one unavoidable JVM dependency (CQL evaluation) is an explicit, swappable compute binding rather than a hidden framework.

## Open questions for Doug (blockers before any code)
- **CQL engine binding transport:** in-process JVM sidecar, HTTP microservice, or a Cloudflare-external evaluator? (Determines whether "Cloudflare-native" can ever be JVM-free, which forces the E9/#78 decision.)
- **Does this supersede or run alongside the E3/E4 Java roadmap?** E3 (MeasureReport, value-set expansion, QRDA) is currently Java backend work; if #96 is near-term, E3 should be authored against the engine binding, not the Spring app.
- Submodule: confirm we should vendor `mieweb/cloud` as a submodule for local + `os.mieweb.org` testing, per the issue.
