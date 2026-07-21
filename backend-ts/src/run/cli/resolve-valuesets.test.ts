import { test } from "node:test";
import assert from "node:assert/strict";
import { runResolve, parseArgs, DEFAULT_OIDS } from "./resolve-valuesets.ts";
import { fixtureVsacClient, type VsacExpansion } from "../../engine/cql/vsac-client.ts";
import type { UpsertResolvedValueSetInput, ValueSetStore } from "../../stores/value-set-store.ts";
import type { AppendAuditInput, CaseEventStore } from "../../stores/case-event-store.ts";

function fakes(existing: Array<{ oid: string; expansionHash: string }> = []) {
  const upserts: UpsertResolvedValueSetInput[] = [];
  const audits: AppendAuditInput[] = [];
  const valueSets = {
    upsertResolvedValueSet: (i: UpsertResolvedValueSetInput) => {
      upserts.push(i);
      return Promise.resolve();
    },
    listAll: () => Promise.resolve(existing),
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

// ---- #295: release pinning + version provenance + drift detection -----------------------------

const OID = "2.16.840.1.113883.3.464.1003.103.12.1001";
const expansionOf = (over: Partial<VsacExpansion> = {}): VsacExpansion => ({
  oid: OID,
  total: 1,
  contains: [{ code: "44054006", system: "http://snomed.info/sct", display: "T2DM" }],
  ...over,
});

test("parseArgs: --manifest / --expansion parse and are mutually exclusive", () => {
  assert.equal(parseArgs(["--manifest", "Library/ecqm-update-2025-05-08"]).manifest, "Library/ecqm-update-2025-05-08");
  assert.equal(parseArgs(["--expansion", "eCQM Update 2025"]).expansion, "eCQM Update 2025");
  assert.throws(() => parseArgs(["--manifest", "a", "--expansion", "b"]), /mutually exclusive/);
  assert.throws(() => parseArgs(["--manifest"]), /needs a value/);
});

test("runResolve forwards the release pin to every $expand", async () => {
  const { valueSets, events } = fakes();
  const client = fixtureVsacClient({ [OID]: expansionOf() });
  await runResolve({
    oids: [OID],
    client,
    valueSets,
    events,
    now: "2026-07-21T00:00:00.000Z",
    manifest: "Library/ecqm-update-2025-05-08",
  });
  assert.deepEqual(client.calls[0]!.opts, { manifest: "Library/ecqm-update-2025-05-08" });
});

test("runResolve records ValueSet.version + expansion provenance instead of hardcoding null", async () => {
  const { upserts, audits, valueSets, events } = fakes();
  const client = fixtureVsacClient({
    [OID]: expansionOf({ version: "20250508", expansionIdentifier: "urn:uuid:abc", expansionTimestamp: "2025-05-08T00:00:00Z" }),
  });
  await runResolve({ oids: [OID], client, valueSets, events, now: "2026-07-21T00:00:00.000Z" });
  assert.equal(upserts[0]!.version, "20250508", "version lands on the row (was always null)");
  const payload = audits[0]!.payload as Record<string, unknown>;
  assert.equal(payload.version, "20250508");
  assert.equal(payload.expansionIdentifier, "urn:uuid:abc");
  assert.equal(payload.expansionTimestamp, "2025-05-08T00:00:00Z");
});

test("expansion hash is SHA-256 and is sensitive to the version, not just the members", async () => {
  const hashFor = async (over: Partial<VsacExpansion>) => {
    const { upserts, valueSets, events } = fakes();
    await runResolve({
      oids: [OID],
      client: fixtureVsacClient({ [OID]: expansionOf(over) }),
      valueSets,
      events,
      now: "2026-07-21T00:00:00.000Z",
    });
    return upserts[0]!.expansionHash!;
  };
  const v1 = await hashFor({ version: "20250508" });
  const v2 = await hashFor({ version: "20260508" }); // same members, republished
  assert.match(v1, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(v1, v2, "a republish under a new version is a different expansion");
  assert.equal(v1, await hashFor({ version: "20250508" }), "hash is deterministic");
});

test("a changed expansion audits VALUE_SET_EXPANSION_CHANGED and is reported", async () => {
  const { audits, valueSets, events } = fakes([{ oid: OID, expansionHash: "sha256:" + "0".repeat(64) }]);
  const client = fixtureVsacClient({ [OID]: expansionOf({ version: "20260508" }) });
  const res = await runResolve({ oids: [OID], client, valueSets, events, now: "2026-07-21T00:00:00.000Z" });
  assert.deepEqual(res.changed, [OID]);
  const drift = audits.find((a) => a.eventType === "VALUE_SET_EXPANSION_CHANGED")!;
  assert.ok(drift, "drift is its own audit event, not buried in VALUE_SETS_RESOLVED");
  assert.equal((drift.payload as { previousExpansionHash: string }).previousExpansionHash, "sha256:" + "0".repeat(64));
});

test("an unchanged re-import reports no drift", async () => {
  // First import to learn the hash, then replay it as the prior state.
  const first = fakes();
  await runResolve({
    oids: [OID],
    client: fixtureVsacClient({ [OID]: expansionOf({ version: "20250508" }) }),
    valueSets: first.valueSets,
    events: first.events,
    now: "2026-07-21T00:00:00.000Z",
  });
  const hash = first.upserts[0]!.expansionHash!;

  const second = fakes([{ oid: OID, expansionHash: hash }]);
  const res = await runResolve({
    oids: [OID],
    client: fixtureVsacClient({ [OID]: expansionOf({ version: "20250508" }) }),
    valueSets: second.valueSets,
    events: second.events,
    now: "2026-07-22T00:00:00.000Z",
  });
  assert.deepEqual(res.changed, []);
  assert.equal(second.audits.filter((a) => a.eventType === "VALUE_SET_EXPANSION_CHANGED").length, 0);
});

test("a legacy (pre-#295) rolling hash is not compared — no false drift on the first import", async () => {
  const { audits, valueSets, events } = fakes([{ oid: OID, expansionHash: "h1a2b3c4d" }]);
  const res = await runResolve({
    oids: [OID],
    client: fixtureVsacClient({ [OID]: expansionOf() }),
    valueSets,
    events,
    now: "2026-07-21T00:00:00.000Z",
  });
  assert.deepEqual(res.changed, [], "algorithm change is not terminology drift");
  assert.equal(audits.filter((a) => a.eventType === "VALUE_SET_EXPANSION_CHANGED").length, 0);
});

test("a first-ever import is not drift (no prior row to compare)", async () => {
  const { audits, valueSets, events } = fakes();
  const res = await runResolve({
    oids: [OID],
    client: fixtureVsacClient({ [OID]: expansionOf() }),
    valueSets,
    events,
    now: "2026-07-21T00:00:00.000Z",
  });
  assert.deepEqual(res.changed, []);
  assert.equal(audits.filter((a) => a.eventType === "VALUE_SET_EXPANSION_CHANGED").length, 0);
});
