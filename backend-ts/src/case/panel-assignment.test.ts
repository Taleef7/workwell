/**
 * Provider panels (MM-2 PR 2, ADR-080) — the backfill rule, and the service that applies it.
 *
 * The rule is the risky part of this feature: it decides, at panel scale, which of someone else's
 * assignments to overwrite. Every case below is a claim about what a panel edit may and may not touch.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { SqlitePanelStore } from "../stores/sqlite/panel-store-sqlite.ts";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import type { CaseRecord } from "../stores/case-store.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import {
  assignPanel,
  panelMapFor,
  planPanelBackfill,
  providerIdsOwnedBy,
  subjectIdsForProvider,
  unassignPanel,
} from "./panel-assignment.ts";

const PANEL_OWNER = "cm@workwell.dev";
const NEW_OWNER = "quality-staff@workwell.dev";

const caseRow = (over: Partial<CaseRecord>): CaseRecord => ({
  id: over.id ?? crypto.randomUUID(),
  employeeId: "emp-001",
  measureId: "audiogram",
  evaluationPeriod: "2026-06-13",
  status: "OPEN",
  priority: "HIGH",
  assignee: null,
  nextAction: null,
  nextActionSource: "SYSTEM",
  assignmentSource: null,
  currentOutcomeStatus: "OVERDUE",
  lastRunId: crypto.randomUUID(),
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  closedAt: null,
  closedReason: null,
  closedBy: null,
  ...over,
});

test("planPanelBackfill moves unowned work and the panel's own earlier assignment — nothing else", () => {
  const unowned = caseRow({ assignee: null, assignmentSource: null });
  const panelOwned = caseRow({ assignee: PANEL_OWNER, assignmentSource: "PANEL" });
  // A supervisor handed this one to the same person by hand. Identical assignee, different meaning:
  // moving it would overrule a decision somebody made deliberately, which is exactly what the
  // provenance column exists to prevent (ADR-080 d1).
  const operatorOwned = caseRow({ assignee: PANEL_OWNER, assignmentSource: "OPERATOR" });
  // Written before the column existed. Unknown provenance reads as operator-owned: the safe answer is
  // the one that declines to move the row.
  const legacyAssigned = caseRow({ assignee: PANEL_OWNER, assignmentSource: null });
  // Someone else entirely — not this panel's to move, whatever wrote it.
  const otherOwner = caseRow({ assignee: "third@workwell.dev", assignmentSource: "PANEL" });
  // Already where it is going: not a change, so not reported and not audited.
  const alreadyThere = caseRow({ assignee: NEW_OWNER, assignmentSource: "PANEL" });
  // A closed case is not work; reassigning it would put a resolved row in somebody's queue.
  const closed = caseRow({ status: "RESOLVED", assignee: null, assignmentSource: null });

  const plan = planPanelBackfill(
    [unowned, panelOwned, operatorOwned, legacyAssigned, otherOwner, alreadyThere, closed],
    PANEL_OWNER,
    NEW_OWNER,
  );

  assert.deepEqual(plan.map((p) => p.id).sort(), [unowned.id, panelOwned.id].sort());
  // The expectations carry the owner that was READ, so a row someone moves in between is skipped by
  // the store's compare-and-set rather than overwritten.
  assert.deepEqual(
    plan.map((p) => p.expectedAssignee).sort(),
    [null, PANEL_OWNER].sort(),
  );
});

test("planPanelBackfill on a FIRST mapping moves only unassigned work", () => {
  // No previous owner, so there is no earlier panel decision to bring up to date — and a case already
  // assigned to somebody was assigned by a person, whoever they are.
  const unowned = caseRow({ assignee: null });
  const someoneElses = caseRow({ assignee: "third@workwell.dev", assignmentSource: "OPERATOR" });
  const plan = planPanelBackfill([unowned, someoneElses], null, NEW_OWNER);
  assert.deepEqual(plan.map((p) => p.id), [unowned.id]);
});

test("planPanelBackfill compares accounts case-insensitively", () => {
  // The stored spelling and the mapping's can differ in case; treating them as different people would
  // leave the panel's own case behind on every edit.
  const panelOwned = caseRow({ assignee: "CM@WorkWell.dev", assignmentSource: "PANEL" });
  const alreadyThere = caseRow({ assignee: "Quality-Staff@workwell.DEV", assignmentSource: "PANEL" });
  const plan = planPanelBackfill([panelOwned, alreadyThere], PANEL_OWNER, NEW_OWNER);
  assert.deepEqual(plan.map((p) => p.id), [panelOwned.id]);
});

test("subjectIdsForProvider returns the WHOLE panel, with no cap", () => {
  // The work list's `panelSubjectIds` caps at 900 and falls back to "no pre-filter", which is fine for
  // a query optimisation and wrong here: this set decides which cases move, so a cap would mean a
  // panel silently backfilling part of itself.
  const roster: EmployeeProfile[] = Array.from({ length: 1500 }, (_, i) => ({
    externalId: `pat-${i}`,
    name: `Patient ${i}`,
    role: "Patient",
    site: "Kihei",
    providerId: i % 2 === 0 ? "maui-prov-012" : "maui-prov-013",
    tenantId: "maui",
  }));
  const ids = subjectIdsForProvider(roster, "maui-prov-012");
  assert.equal(ids.length, 750);
  assert.equal(ids[0], "pat-0");
  assert.deepEqual(subjectIdsForProvider(roster, "maui-prov-999"), [], "an unmapped provider has no patients");
});

test("panelMapFor and providerIdsOwnedBy read the mapping from both ends", () => {
  const panels = [
    { providerId: "maui-prov-012", assignee: PANEL_OWNER, createdBy: null, createdAt: "", updatedAt: "" },
    { providerId: "maui-prov-013", assignee: "CM@WorkWell.dev", createdBy: null, createdAt: "", updatedAt: "" },
    { providerId: "maui-prov-014", assignee: NEW_OWNER, createdBy: null, createdAt: "", updatedAt: "" },
  ];
  assert.equal(panelMapFor(panels).get("maui-prov-012"), PANEL_OWNER);
  // One staff member owns MANY providers — nine staff to forty-odd providers is the practice's shape.
  assert.deepEqual(providerIdsOwnedBy(panels, PANEL_OWNER), ["maui-prov-012", "maui-prov-013"]);
  assert.deepEqual(providerIdsOwnedBy(panels, "nobody@workwell.dev"), []);
  assert.deepEqual(providerIdsOwnedBy(panels, null), [], "no viewer owns no panels");
  assert.deepEqual(providerIdsOwnedBy(panels, "   "), []);
});

// --- the service, against the real floor stores ------------------------------------------------

const created: string[] = [];
after(() => {
  for (const dbPath of created) {
    try {
      rmSync(dbPath, { force: true });
    } catch {
      /* best effort */
    }
  }
});

async function freshDeps(roster: readonly EmployeeProfile[]) {
  const dbPath = join(tmpdir(), `workwell-panel-${crypto.randomUUID()}.sqlite`);
  created.push(dbPath);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return {
    panels: new SqlitePanelStore(db),
    cases: new SqliteCaseStore(db),
    events: new SqliteCaseEventStore(db),
    roster,
  };
}

const ROSTER: EmployeeProfile[] = [
  { externalId: "pat-001", name: "A", role: "Patient", site: "Kihei", providerId: "maui-prov-012", tenantId: "maui" },
  { externalId: "pat-002", name: "B", role: "Patient", site: "Kihei", providerId: "maui-prov-012", tenantId: "maui" },
  { externalId: "pat-003", name: "C", role: "Patient", site: "Kihei", providerId: "maui-prov-013", tenantId: "maui" },
];

const openCaseFor = (deps: Awaited<ReturnType<typeof freshDeps>>, subjectId: string, measureId = "cms122") =>
  deps.cases.upsertFromOutcome({
    runId: crypto.randomUUID(),
    subjectId,
    measureId,
    evaluationPeriod: "2027-01-01",
    outcomeStatus: "OVERDUE",
  });

test("assignPanel maps the provider and moves that provider's open cases only", async () => {
  const deps = await freshDeps(ROSTER);
  const a = (await openCaseFor(deps, "pat-001"))!;
  const b = (await openCaseFor(deps, "pat-002"))!;
  const other = (await openCaseFor(deps, "pat-003"))!;

  const result = await assignPanel(deps, {
    providerId: "maui-prov-012",
    assignee: NEW_OWNER,
    actor: "quality-lead@workwell.dev",
    providerName: "Dr Tide",
  });

  assert.equal(result.changed, true);
  assert.equal(result.previousAssignee, null);
  assert.equal(result.backfillPlanned, 2);
  assert.equal(result.backfilled, 2);
  assert.equal((await deps.cases.getCase(a.id))?.assignee, NEW_OWNER);
  assert.equal((await deps.cases.getCase(b.id))?.assignmentSource, "PANEL");
  assert.equal((await deps.cases.getCase(other.id))?.assignee, null, "another provider's panel is untouched");
  assert.equal((await deps.panels.getPanelAssignment("maui-prov-012"))?.assignee, NEW_OWNER);
});

test("assignPanel writes the panel event BEFORE the mapping, and a CASE_ASSIGNED per case moved", async () => {
  const deps = await freshDeps(ROSTER);
  const a = (await openCaseFor(deps, "pat-001"))!;
  await openCaseFor(deps, "pat-002");

  await assignPanel(deps, { providerId: "maui-prov-012", assignee: NEW_OWNER, actor: "quality-lead@workwell.dev" });

  const ledger = await deps.events.listAuditEvents(100, 0);
  const panelEvent = ledger.find((e) => e.eventType === "PANEL_ASSIGNED");
  assert.ok(panelEvent, "the decision itself is audited, not only its consequences");
  assert.equal((panelEvent?.payload as Record<string, unknown>).providerId, "maui-prov-012");
  assert.equal((panelEvent?.payload as Record<string, unknown>).assignee, NEW_OWNER);
  assert.equal((panelEvent?.payload as Record<string, unknown>).previousAssignee, "unassigned");
  assert.equal((panelEvent?.payload as Record<string, unknown>).backfillPlanned, 2);

  const assigned = ledger.filter((e) => e.eventType === "CASE_ASSIGNED");
  assert.equal(assigned.length, 2, "every case that moved has its own ledger entry");
  assert.equal((assigned[0]?.payload as Record<string, unknown>).panel, "maui-prov-012");

  // The case_actions arm too — a case moved by a panel edit leaves the same rows as one moved by hand.
  const timeline = await deps.events.caseTimeline(a.id);
  assert.ok(timeline.some((t) => t.eventType === "CASE_ASSIGNED"));
});

test("re-saving the same assignee writes nothing when there is nothing to do", async () => {
  const deps = await freshDeps(ROSTER);
  await openCaseFor(deps, "pat-001");
  await assignPanel(deps, { providerId: "maui-prov-012", assignee: NEW_OWNER, actor: "lead@workwell.dev" });
  const before = await deps.events.listAuditEvents(100, 0);

  const again = await assignPanel(deps, { providerId: "maui-prov-012", assignee: NEW_OWNER, actor: "lead@workwell.dev" });

  assert.equal(again.changed, false, "the mapping did not move");
  assert.equal(again.backfilled, 0);
  // A ledger entry describing a decision nobody made is worse than no entry, because a reader cannot
  // tell it from one that mattered.
  assert.equal((await deps.events.listAuditEvents(100, 0)).length, before.length);
});

test("re-saving the same assignee DOES sweep the panel's unassigned work", async () => {
  // The recovery path for a run that opened cases unassigned on a mapped panel — which can happen,
  // because reading the panels during a run is best-effort (they must never fail a run). Without this
  // the only way to pick those cases up would be to un-map the panel and map it again.
  const deps = await freshDeps(ROSTER);
  await assignPanel(deps, { providerId: "maui-prov-012", assignee: NEW_OWNER, actor: "lead@workwell.dev" });
  const stranded = (await openCaseFor(deps, "pat-001"))!; // opened afterwards, with no assignee
  assert.equal(stranded.assignee, null);

  const again = await assignPanel(deps, { providerId: "maui-prov-012", assignee: NEW_OWNER, actor: "lead@workwell.dev" });

  assert.equal(again.changed, false, "the mapping is unchanged, and says so");
  assert.equal(again.backfilled, 1, "but the work moved, and says that too");
  assert.equal((await deps.cases.getCase(stranded.id))?.assignee, NEW_OWNER);
  assert.equal((await deps.cases.getCase(stranded.id))?.assignmentSource, "PANEL");
});

test("re-mapping a panel moves its own assignments and leaves an operator's alone", async () => {
  const deps = await freshDeps(ROSTER);
  const panelCase = (await openCaseFor(deps, "pat-001"))!;
  const handPicked = (await openCaseFor(deps, "pat-002"))!;

  await assignPanel(deps, { providerId: "maui-prov-012", assignee: PANEL_OWNER, actor: "lead@workwell.dev" });
  // A supervisor hands one case to the SAME person by hand. Same assignee, different provenance.
  await deps.cases.patchCase(handPicked.id, { assignee: PANEL_OWNER });

  const moved = await assignPanel(deps, { providerId: "maui-prov-012", assignee: NEW_OWNER, actor: "lead@workwell.dev" });

  assert.equal(moved.previousAssignee, PANEL_OWNER);
  assert.equal(moved.backfilled, 1);
  assert.equal((await deps.cases.getCase(panelCase.id))?.assignee, NEW_OWNER, "the panel's own assignment follows the panel");
  assert.equal((await deps.cases.getCase(handPicked.id))?.assignee, PANEL_OWNER, "a person's assignment stands");
});

test("unassignPanel removes the mapping, audits it, and leaves open cases assigned", async () => {
  const deps = await freshDeps(ROSTER);
  const a = (await openCaseFor(deps, "pat-001"))!;
  await assignPanel(deps, { providerId: "maui-prov-012", assignee: NEW_OWNER, actor: "lead@workwell.dev" });

  const removed = await unassignPanel(deps, { providerId: "maui-prov-012", actor: "lead@workwell.dev" });

  assert.equal(removed?.assignee, NEW_OWNER);
  assert.equal(await deps.panels.getPanelAssignment("maui-prov-012"), null);
  // ADR-080 d4: un-mapping says who owns FUTURE work. Dropping a few hundred in-flight cases because
  // a supervisor tidied a mapping would lose real work, silently.
  assert.equal((await deps.cases.getCase(a.id))?.assignee, NEW_OWNER, "work in flight keeps its owner");
  const unassignEvent = (await deps.events.listAuditEvents(100, 0)).find((e) => e.eventType === "PANEL_UNASSIGNED");
  assert.equal((unassignEvent?.payload as Record<string, unknown>).previousAssignee, NEW_OWNER);
});

test("unassignPanel on an unmapped provider is null and writes nothing", async () => {
  const deps = await freshDeps(ROSTER);
  assert.equal(await unassignPanel(deps, { providerId: "maui-prov-012", actor: "lead@workwell.dev" }), null);
  assert.deepEqual(await deps.events.listAuditEvents(100, 0), []);
});

test("assignPanel reads a panel larger than one chunk", async () => {
  // The read is chunked at 1,000 subjects and the assign at 500 cases, so a panel that spans both
  // boundaries is the case where an off-by-one leaves part of the panel behind — silently, because a
  // partial backfill looks exactly like a correct one from the outside.
  const big: EmployeeProfile[] = Array.from({ length: 1200 }, (_, i) => ({
    externalId: `pat-${String(i).padStart(4, "0")}`,
    name: `Patient ${i}`,
    role: "Patient",
    site: "Kihei",
    providerId: "maui-prov-012",
    tenantId: "maui",
  }));
  const deps = await freshDeps(big);
  for (const employee of big) await openCaseFor(deps, employee.externalId);

  const result = await assignPanel(deps, { providerId: "maui-prov-012", assignee: NEW_OWNER, actor: "lead@workwell.dev" });

  assert.equal(result.backfillPlanned, 1200);
  assert.equal(result.backfilled, 1200, "every case in the panel moved, across both chunk boundaries");
});
