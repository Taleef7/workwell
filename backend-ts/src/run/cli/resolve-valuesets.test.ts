import { test } from "node:test";
import assert from "node:assert/strict";
import { runResolve, parseArgs, DEFAULT_OIDS } from "./resolve-valuesets.ts";
import { fixtureVsacClient, type VsacExpansion } from "../../engine/cql/vsac-client.ts";
import type { UpsertResolvedValueSetInput, ValueSetStore } from "../../stores/value-set-store.ts";
import type { AppendAuditInput, CaseEventStore } from "../../stores/case-event-store.ts";

function fakes() {
  const upserts: UpsertResolvedValueSetInput[] = [];
  const audits: AppendAuditInput[] = [];
  const valueSets = {
    upsertResolvedValueSet: (i: UpsertResolvedValueSetInput) => {
      upserts.push(i);
      return Promise.resolve();
    },
  } as unknown as ValueSetStore;
  const events = {
    appendAudit: (a: AppendAuditInput) => {
      audits.push(a);
      return Promise.resolve();
    },
  } as unknown as CaseEventStore;
  return { upserts, audits, valueSets, events };
}

test("parseArgs: --oid is repeatable; default is the CMS122 reference set", () => {
  assert.deepEqual(parseArgs(["--oid", "1.2.3", "--oid", "4.5.6"]).oids, ["1.2.3", "4.5.6"]);
  assert.ok(DEFAULT_OIDS.length > 5);
  assert.equal(parseArgs([]).oids, undefined); // undefined → caller uses DEFAULT_OIDS
});

test("runResolve upserts a RESOLVED row + audits per resolved oid", async () => {
  const { upserts, audits, valueSets, events } = fakes();
  const oid = "2.16.840.1.113883.3.464.1003.103.12.1001";
  const exp: VsacExpansion = { oid, total: 1, contains: [{ code: "44054006", system: "http://snomed.info/sct", display: "T2DM" }] };
  const client = fixtureVsacClient({ [oid]: exp });
  const res = await runResolve({ oids: [oid], client, valueSets, events, now: "2026-07-05T00:00:00.000Z" });
  assert.equal(res.resolved, 1);
  assert.equal(res.errors, 0);
  assert.equal(upserts[0]!.resolutionStatus, "RESOLVED");
  assert.equal(upserts[0]!.source, "VSAC");
  assert.equal(upserts[0]!.codes[0]!.code, "44054006");
  assert.equal(audits[0]!.eventType, "VALUE_SETS_RESOLVED");
});

test("runResolve writes an ERROR row and continues when an oid fails to expand", async () => {
  const { upserts, valueSets, events } = fakes();
  const ok = "2.16.840.1.113883.3.464.1003.103.12.1001";
  const bad = "2.16.840.1.113883.3.464.1003.1003";
  const client = fixtureVsacClient({ [ok]: { oid: ok, total: 0, contains: [] } }); // `bad` has no fixture → rejects
  const res = await runResolve({ oids: [bad, ok], client, valueSets, events, now: "2026-07-05T00:00:00.000Z" });
  assert.equal(res.errors, 1);
  assert.equal(res.resolved, 1);
  const errRow = upserts.find((u) => u.oid === bad)!;
  assert.equal(errRow.resolutionStatus, "ERROR");
  assert.ok(errRow.resolutionError);
});
