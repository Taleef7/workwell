/**
 * E15 PR-1 — identity resolution: matchKey/normalize correctness, cross-system grouping, the E13
 * reconciliation guard (All = Σ tenants still holds with cross-system people), and the mobility timeline.
 *   node --import tsx --test src/identity/identity-model.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchKey, normalizeName, personIdFor, resolvePeople, duplicateCandidates, MOBILITY_OVERLAY,
} from "./identity-model.ts";
import { mergedComplianceTimeline, type TimelineOutcome } from "./compliance-timeline.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import type { PersonLink } from "../stores/person-link-store.ts";

const link = (aExt: string, aTen: string, bExt: string, bTen: string, linkType: "CONFIRMED" | "BROKEN"): PersonLink => ({
  id: `${aExt}-${bExt}`, a: { tenantId: aTen, externalId: aExt }, b: { tenantId: bTen, externalId: bExt },
  linkType, createdBy: "test", createdAt: "2026-07-01T00:00:00.000Z",
});

test("normalizeName folds case/whitespace/diacritics", () => {
  assert.equal(normalizeName("  Omar   Siddiq "), "omar siddiq");
  assert.equal(normalizeName("Renée"), "renee");
});

test("matchKey groups on a shared nationalId; absent ⇒ unique local key", () => {
  assert.equal(matchKey({ tenantId: "twh", externalId: "emp-006", nationalId: "NID-100-OMAR" }), "nid:nid-100-omar");
  assert.equal(matchKey({ tenantId: "ihn", externalId: "ihn-emp-001", nationalId: "NID-100-OMAR" }), "nid:nid-100-omar");
  // no shared id ⇒ each record is its own key, never grouped by accident
  assert.equal(matchKey({ tenantId: "twh", externalId: "emp-005", nationalId: undefined }), "local:twh:emp-005");
  // a blank/whitespace-only id must NOT collapse to the shared `nid:` key (defensive false-group guard)
  assert.equal(matchKey({ tenantId: "twh", externalId: "emp-005", nationalId: "   " }), "local:twh:emp-005");
  assert.notEqual(
    matchKey({ tenantId: "twh", externalId: "emp-005", nationalId: undefined }),
    matchKey({ tenantId: "ihn", externalId: "ihn-emp-050", nationalId: undefined }),
  );
});

test("personIdFor is deterministic + reproducible", () => {
  assert.equal(personIdFor("nid:nid-100-omar"), personIdFor("nid:nid-100-omar"));
  assert.match(personIdFor("nid:nid-100-omar"), /^person-[0-9a-f]{8}$/);
});

test("resolvePeople groups the two seeded cross-system pairs, everyone else singleton", () => {
  const people = resolvePeople();
  const cross = people.filter((p) => p.crossSystem);
  assert.equal(cross.length, 2, "exactly the two seeded cross-system people");
  // Every source record is accounted for exactly once (146 singletons + 2×2 = 150).
  const linkCount = people.reduce((n, p) => n + p.sources.length, 0);
  assert.equal(linkCount, EMPLOYEES.length);
  const omar = cross.find((p) => p.nationalId === "NID-100-OMAR")!;
  assert.equal(omar.sources.length, 2);
  assert.deepEqual([...new Set(omar.sources.map((s) => s.tenantId))].sort(), ["ihn", "twh"]);
  // ACTIVE source leads (Omar's twh link is PRIOR → ihn leads).
  assert.equal(omar.sources[0]!.status, "ACTIVE");
  assert.equal(omar.sources[0]!.tenantId, "ihn");
});

test("duplicateCandidates = cross-system people with NO prior link (moved excluded)", () => {
  const dups = duplicateCandidates();
  assert.equal(dups.length, 1, "Sana (active in both) is a duplicate; Omar (moved) is not");
  assert.equal(dups[0]!.nationalId, "NID-200-SANA");
  assert.ok(dups.every((p) => p.crossSystem && !p.sources.some((s) => s.status === "PRIOR")));
});

test("E13 reconciliation guard: each source record still belongs to exactly one tenant", () => {
  // Identity groups records but must NOT move a record between tenants — Σ per-tenant source links
  // over all people equals the per-tenant directory counts (so All = Σ tenants is preserved).
  const perTenant = new Map<string, number>();
  for (const p of resolvePeople()) {
    for (const s of p.sources) perTenant.set(s.tenantId, (perTenant.get(s.tenantId) ?? 0) + 1);
  }
  const expected = new Map<string, number>();
  for (const e of EMPLOYEES) expected.set(e.tenantId, (expected.get(e.tenantId) ?? 0) + 1);
  assert.deepEqual(perTenant, expected);
});

test("a CONFIRMED link unions two records without a shared nationalId", () => {
  // emp-005 (twh) and ihn-emp-050 (ihn) share no nationalId → normally two singletons.
  const dir = EMPLOYEES.filter((e) => e.externalId === "emp-005" || e.externalId === "ihn-emp-050");
  assert.equal(resolvePeople(dir).length, 2, "two singletons without a link");
  const linked = resolvePeople(dir, [link("emp-005", "twh", "ihn-emp-050", "ihn", "CONFIRMED")]);
  assert.equal(linked.length, 1, "confirmed → one cross-system person");
  assert.equal(linked[0]!.crossSystem, true);
  assert.equal(linked[0]!.sources.length, 2);
});

test("a BROKEN link splits an auto-matched (shared-id) pair", () => {
  const dir = EMPLOYEES.filter((e) => e.externalId === "emp-007" || e.externalId === "ihn-emp-002");
  assert.equal(resolvePeople(dir).length, 1, "shared nationalId auto-groups them");
  const split = resolvePeople(dir, [link("emp-007", "twh", "ihn-emp-002", "ihn", "BROKEN")]);
  assert.equal(split.length, 2, "broken → two singletons");
  assert.ok(split.every((p) => !p.crossSystem));
});

test("mergedComplianceTimeline unions sources, newest-first, with a move annotation", () => {
  const omar = resolvePeople().find((p) => p.nationalId === "NID-100-OMAR")!;
  const outcomes = new Map<string, TimelineOutcome[]>([
    ["emp-006", [{ measureId: "audiogram", status: "OVERDUE", evaluatedAt: "2026-01-10T00:00:00.000Z" }]], // twh (PRIOR)
    ["ihn-emp-001", [{ measureId: "flu_vaccine", status: "COMPLIANT", evaluatedAt: "2026-06-10T00:00:00.000Z" }]], // ihn (ACTIVE)
  ]);
  const { entries, move } = mergedComplianceTimeline(omar, outcomes);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.evaluatedAt, "2026-06-10T00:00:00.000Z", "newest first");
  assert.equal(entries[0]!.tenantId, "ihn");
  assert.ok(move, "a move annotation is present");
  assert.equal(move!.fromTenantName, "Total Worker Health");
  assert.equal(move!.toTenantName, "Indus Hospital Network");
  assert.equal(move!.date, MOBILITY_OVERLAY["emp-006"]!.moveDate);
});
