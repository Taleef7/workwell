/**
 * CDS Hooks route (ADR-067).
 *   node --import tsx --test src/routes/cds-hooks.test.ts
 *
 * Two assertions here matter more than the rest. **The auth matrix**: `/cds-services` is outside `/api/`,
 * where `authorize` ends in permitAll, so without an explicit rule the invoke endpoint would serve
 * per-patient clinical status anonymously — this test is the guard on that, and it is asserted as a pure
 * `authorize` call so it cannot be confused with handler behaviour. **The absence cases**: a patient we
 * have not evaluated, and a patient whose only rows belong to an unfinished run, must both produce a card
 * that says so rather than an empty list a clinician would read as "no gaps".
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteValueSetStore } from "../stores/sqlite/value-set-store-sqlite.ts";
import { authorize } from "../auth/authorize.ts";
import { getStores } from "../stores/factory.ts";
import { cardUuid } from "../cds/cards.ts";
import { PATIENT_VIEW_SERVICE_ID } from "../cds/discovery.ts";
import { candidateSubjectIds, handleCdsHooks, parseCdsPath } from "./cds-hooks.ts";
import type { JwtPrincipal } from "../auth/jwt.ts";

const dbPath = join(tmpdir(), `ww-cds-hooks-${crypto.randomUUID()}.sqlite`);
let env: Record<string, unknown>;
let completedRunId: string;

const INVOKE = `/cds-services/${PATIENT_VIEW_SERVICE_ID}`;
const OVERDUE_EVIDENCE = {
  expressionResults: [
    { define: "Most Recent Audiogram Date", result: "2025-03-10T00:00:00Z" },
    { define: "Days Since Last Audiogram", result: 420 },
  ],
};

const call = (path: string, init?: RequestInit) =>
  handleCdsHooks(new Request(`http://x${path}`, init), env as never, "tester@workwell.dev");

const post = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const hookBody = (patientId: string, over: Record<string, unknown> = {}) => ({
  hook: "patient-view",
  hookInstance: crypto.randomUUID(),
  context: { userId: "Practitioner/abc", patientId },
  ...over,
});

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db, WORKWELL_CORS_ALLOWED_ORIGINS: "https://studio.example.org" };
  const runs = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  const valueSets = new SqliteValueSetStore(db);

  // The APPROVED mapping that unlocks the audiogram suggestion, and a REVIEWED one that must not.
  await valueSets.createTerminologyMapping({
    id: crypto.randomUUID(),
    localCode: "LOCAL-AUD-002", localDisplay: "Annual audiogram", localSystem: "urn:workwell:demo",
    standardCode: "92557", standardDisplay: "Comprehensive audiometry evaluation",
    standardSystem: "http://www.ama-assn.org/go/cpt", mappingStatus: "APPROVED", mappingConfidence: 0.98, notes: null,
  });
  await valueSets.createTerminologyMapping({
    id: crypto.randomUUID(),
    localCode: "LOCAL-HAZ-001", localDisplay: "HAZWOPER exam", localSystem: "urn:workwell:demo",
    standardCode: "hazwoper-exam", standardDisplay: "HAZWOPER Surveillance Exams",
    standardSystem: "urn:workwell:vs:hazwoper-exams", mappingStatus: "REVIEWED", mappingConfidence: 0.8, notes: null,
  });

  const completed = await runs.createRun({
    scopeType: "ALL_PROGRAMS", triggeredBy: "test", requestedScope: {},
    measurementPeriodStart: "2025-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
  });
  await runs.finalizeRun(completed.id, "COMPLETED");
  completedRunId = completed.id;

  // emp-006: one open gap (suggestible) + one that must not be suggested + one compliant (no card).
  await outcomes.recordOutcome({ runId: completed.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evaluationPeriod: "2026-06-12", evidence: OVERDUE_EVIDENCE });
  await outcomes.recordOutcome({ runId: completed.id, subjectId: "emp-006", measureId: "hazwoper", status: "OVERDUE", evaluationPeriod: "2026-06-12", evidence: OVERDUE_EVIDENCE });
  await outcomes.recordOutcome({ runId: completed.id, subjectId: "emp-006", measureId: "flu_vaccine", status: "COMPLIANT", evaluationPeriod: "2026-06-12", evidence: {} });
  // emp-007: evaluated and clean — the ONLY subject that legitimately gets an empty card list.
  await outcomes.recordOutcome({ runId: completed.id, subjectId: "emp-007", measureId: "audiogram", status: "COMPLIANT", evaluationPeriod: "2026-06-12", evidence: {} });
  // wc|4821: the live-namespace subject, reachable only if a bare hook patientId is tried as `wc|<id>`.
  await outcomes.recordOutcome({ runId: completed.id, subjectId: "wc|4821", measureId: "audiogram", status: "OVERDUE", evaluationPeriod: "2026-06-12", evidence: OVERDUE_EVIDENCE });

  // emp-mid: rows exist but the run never finalized. Serving these would publish a partial result.
  const running = await runs.createRun({
    scopeType: "ALL_PROGRAMS", triggeredBy: "test", requestedScope: {},
    measurementPeriodStart: "2025-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
  });
  await outcomes.recordOutcome({ runId: running.id, subjectId: "emp-mid", measureId: "audiogram", status: "OVERDUE", evaluationPeriod: "2026-06-12", evidence: OVERDUE_EVIDENCE });
});

after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("the path matcher claims only its own shapes", () => {
  assert.deepEqual(parseCdsPath("/cds-services"), { kind: "discovery" });
  assert.deepEqual(parseCdsPath("/cds-services/abc"), { kind: "invoke", serviceId: "abc" });
  assert.deepEqual(parseCdsPath("/cds-services/abc/feedback"), { kind: "feedback", serviceId: "abc" });
  for (const p of ["/api/cds-services", "/cds-services/a/b", "/cds-services/a/feedback/x", "/cds", "/cds-servicesx"]) {
    assert.equal(parseCdsPath(p), null, `${p} must not be claimed`);
  }
  // A bad percent-escape must not reach the worker's catch-all as a 500 (the #399 lesson).
  assert.equal(parseCdsPath("/cds-services/%E0%A4%A"), null);
});

test("a non-matching path returns null so the worker keeps dispatching", async () => {
  assert.equal(await call("/api/v1/compliance/emp-006/audiogram"), null);
});

test("discovery is one service, declares NO prefetch, and states what it does not do", async () => {
  const res = (await call("/cds-services"))!;
  assert.equal(res.status, 200);
  const body = (await res.json()) as { services: Array<Record<string, unknown>> };
  assert.equal(body.services.length, 1);
  const svc = body.services[0]!;
  assert.equal(svc["hook"], "patient-view");
  assert.equal(svc["id"], PATIENT_VIEW_SERVICE_ID);
  // Declaring a prefetch template we then ignore would make a client fetch and send data for nothing.
  assert.equal(svc["prefetch"], undefined, "no prefetch may be declared");
  assert.match(String(svc["usageRequirements"]), /does not evaluate data supplied on the request/);
  assert.match(String(svc["usageRequirements"]), /never an empty card list/);
});

test("discovery refuses a non-GET; an unknown service is a 404 that lists what exists", async () => {
  assert.equal((await post("/cds-services", {}))!.status, 405);
  const res = (await post("/cds-services/not-a-service", hookBody("emp-006")))!;
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string; known: string[] };
  assert.equal(body.error, "unknown_service");
  assert.deepEqual(body.known, [PATIENT_VIEW_SERVICE_ID]);
  // A GET on the invoke path is a method error, not a silent empty response.
  assert.equal((await call(INVOKE))!.status, 405);
});

test("invoke validates the hook contract before answering", async () => {
  const cases: Array<[string, unknown]> = [
    ["hook and hookInstance are required", { context: { patientId: "emp-006" } }],
    ["hook and hookInstance are required", { hook: "patient-view", context: { patientId: "emp-006" } }],
    ["context.patientId is required", { hook: "patient-view", hookInstance: "x", context: {} }],
  ];
  for (const [expected, body] of cases) {
    const res = (await post(INVOKE, body))!;
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(((await res.json()) as { message: string }).message, new RegExp(expected));
  }
  // A hook this service does not serve is refused rather than answered — the context fields may differ.
  const wrongHook = (await post(INVOKE, hookBody("emp-006", { hook: "order-sign" })))!;
  assert.equal(wrongHook.status, 400);
  assert.match(((await wrongHook.json()) as { message: string }).message, /serves hook 'patient-view'/);
  // A body that is not JSON at all.
  const malformed = (await call(INVOKE, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" }))!;
  assert.equal(malformed.status, 400);
});

test("invoke returns one card per open gap, with a suggestion only where the mapping is APPROVED", async () => {
  const res = (await post(INVOKE, hookBody("emp-006")))!;
  assert.equal(res.status, 200);
  const { cards } = (await res.json()) as { cards: Array<Record<string, unknown>> };
  // audiogram + hazwoper are open; flu_vaccine is COMPLIANT and contributes nothing.
  assert.equal(cards.length, 2);
  const byMeasure = new Map(cards.map((c) => [String(c["summary"]).split(" — ")[0], c]));
  const audiogram = byMeasure.get("Annual Audiogram Completed")!;
  const hazwoper = byMeasure.get("HAZWOPER Surveillance")!;
  assert.ok(audiogram, "the audiogram gap must be carded");
  // APPROVED (CPT 92557) → offered. REVIEWED with an internal code → information only.
  assert.equal((audiogram["suggestions"] as unknown[]).length, 1);
  assert.equal(hazwoper["suggestions"], undefined, "a REVIEWED mapping must not be offered as an order");
  // The card identity is the derived one, so a later feedback POST is correlatable.
  assert.equal(audiogram["uuid"], await cardUuid(completedRunId, "emp-006", "audiogram"));
});

test("a bare hook patientId resolves the `wc|` live namespace", async () => {
  // The trap: a WebChart client sends `4821`, WorkWell persists `wc|4821`. Without this the card list
  // would be the no-evaluation card, which reads as "WorkWell doesn't know them" rather than a real gap.
  assert.deepEqual(candidateSubjectIds("4821"), ["wc|4821", "4821"]);
  assert.deepEqual(candidateSubjectIds("wc|4821"), ["wc|4821"], "an already-namespaced id is not double-prefixed");
  const { cards } = (await (await post(INVOKE, hookBody("4821")))!.json()) as { cards: Array<Record<string, unknown>> };
  assert.equal(cards.length, 1);
  assert.match(String(cards[0]!["summary"]), /Annual Audiogram Completed/);
});

test("an evaluated-and-clean subject gets an EMPTY card list — the only correct silence", async () => {
  const { cards } = (await (await post(INVOKE, hookBody("emp-007")))!.json()) as { cards: unknown[] };
  assert.deepEqual(cards, []);
});

test("an unknown patient, and a mid-run patient, each get a CARD saying so — never silence", async () => {
  for (const patientId of ["nobody-at-all", "emp-mid"]) {
    const { cards } = (await (await post(INVOKE, hookBody(patientId)))!.json()) as {
      cards: Array<Record<string, unknown>>;
    };
    assert.equal(cards.length, 1, `${patientId} must get exactly one card`);
    assert.equal(cards[0]!["indicator"], "info");
    assert.match(String(cards[0]!["summary"]), /No WorkWell evaluation on record/, patientId);
    // The distinction that matters: this must not be confusable with the empty list above.
    assert.match(String(cards[0]!["detail"]), /absence of a run/);
  }
});

test("every invocation writes an audit event carrying the uuids it emitted", async () => {
  const stores = await getStores(env as never);
  const count = async (type: string) =>
    (await stores.events.listAuditEvents(1000)).filter((e) => e.eventType === type).length;
  const before = await count("CDS_HOOKS_INVOKED");
  await post(INVOKE, hookBody("emp-006"));
  assert.equal(await count("CDS_HOOKS_INVOKED"), before + 1);
  // A patient with nothing on record is a read too — enumeration must not be the silent case.
  await post(INVOKE, hookBody("nobody-at-all"));
  assert.equal(await count("CDS_HOOKS_INVOKED"), before + 2);

  const latest = (await stores.events.listAuditEvents(1000)).find((e) => e.eventType === "CDS_HOOKS_INVOKED")!;
  const payload = latest.payload as Record<string, unknown>;
  assert.equal(payload["sensitivityLabel"], "restricted");
  assert.ok(Array.isArray(payload["cardUuids"]), "the emitted uuids must be recorded for correlation");

  // Discovery must NOT write: it carries no patient data, and a public endpoint writing per request is a
  // denial-of-service amplifier against our own ledger.
  const beforeDiscovery = await count("CDS_HOOKS_INVOKED");
  await call("/cds-services");
  assert.equal(await count("CDS_HOOKS_INVOKED"), beforeDiscovery);
});

test("feedback validates the spec's conditional fields and records the outcome", async () => {
  const path = `${INVOKE}/feedback`;
  const uuid = await cardUuid(completedRunId, "emp-006", "audiogram");
  const bad: unknown[] = [
    { feedback: [] },
    { feedback: [{ card: uuid, outcome: "declined", outcomeTimestamp: "2026-06-12T00:00:00Z" }] },
    { feedback: [{ card: uuid, outcome: "accepted", outcomeTimestamp: "2026-06-12T00:00:00Z" }] },
    { feedback: [{ outcome: "overridden", outcomeTimestamp: "2026-06-12T00:00:00Z" }] },
  ];
  for (const body of bad) {
    assert.equal((await post(path, body))!.status, 400, JSON.stringify(body));
  }

  const stores = await getStores(env as never);
  const count = async () =>
    (await stores.events.listAuditEvents(1000)).filter((e) => e.eventType === "CDS_HOOKS_FEEDBACK_RECEIVED").length;
  const before = await count();
  const ok = (await post(path, {
    feedback: [
      { card: uuid, outcome: "accepted", acceptedSuggestions: [{ id: "s1" }], outcomeTimestamp: "2026-06-12T00:00:00Z" },
      { card: uuid, outcome: "overridden", outcomeTimestamp: "2026-06-12T00:00:00Z", overrideReason: { reason: { code: "not-now", system: "urn:x" }, userComment: "patient declined today" } },
    ],
  }))!;
  assert.equal(ok.status, 200);
  assert.equal(await count(), before + 2, "one audit event per feedback entry");
  const rows = (await stores.events.listAuditEvents(1000)).filter((e) => e.eventType === "CDS_HOOKS_FEEDBACK_RECEIVED");
  const overridden = rows.find((r) => (r.payload as Record<string, unknown>)["outcome"] === "overridden")!;
  assert.equal((overridden.payload as Record<string, unknown>)["overrideReasonCode"], "not-now");
});

test("the auth matrix: discovery is public, invoke and feedback are not", () => {
  // A pure `authorize` call, not a handler call — the gate runs in the worker before any handler, so
  // asserting it here is asserting the thing that actually protects the route.
  const viewer: JwtPrincipal = { email: "v@workwell.dev", role: "ROLE_VIEWER" } as JwtPrincipal;
  const cm: JwtPrincipal = { email: "cm@workwell.dev", role: "ROLE_CASE_MANAGER" } as JwtPrincipal;
  const mcp: JwtPrincipal = { email: "m@workwell.dev", role: "ROLE_MCP_CLIENT" } as JwtPrincipal;
  const author: JwtPrincipal = { email: "a@workwell.dev", role: "ROLE_AUTHOR" } as JwtPrincipal;

  assert.deepEqual(authorize("GET", "/cds-services", null), { ok: true }, "discovery must be public");

  // Invoke and feedback: anonymous is 401, and `/cds-services` is OUTSIDE `/api/`, where `authorize`
  // otherwise ends in permitAll — so this assertion is the whole reason the rules exist.
  for (const p of [`/cds-services/${PATIENT_VIEW_SERVICE_ID}`, `/cds-services/${PATIENT_VIEW_SERVICE_ID}/feedback`]) {
    assert.deepEqual(authorize("POST", p, null), { ok: false, status: 401 }, p);
    assert.deepEqual(authorize("POST", p, cm), { ok: true }, p);
    assert.deepEqual(authorize("POST", p, mcp), { ok: true }, p);
    assert.deepEqual(authorize("POST", p, author), { ok: false, status: 403 }, `${p} is not authoring work`);
    // ROLE_VIEWER backs the public read-only sandbox and may never write — a POST here would also be a
    // per-patient clinical read on someone else's behalf.
    assert.deepEqual(authorize("POST", p, viewer), { ok: false, status: 403 }, p);
  }
  // A non-GET on the bare discovery path falls through to the gated rule rather than being public.
  assert.deepEqual(authorize("POST", "/cds-services", null), { ok: false, status: 401 });
});
