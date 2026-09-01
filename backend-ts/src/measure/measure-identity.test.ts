import { test } from "node:test";
import assert from "node:assert/strict";
import { MEASURE_CATALOG } from "./measure-catalog.ts";
import {
  MEASURE_IDENTITY,
  measureIdentityFor,
} from "./measure-identity.ts";

test("measureIdentityFor returns identity for CMS measures and null for non-CMS measures", () => {
  assert.deepEqual(measureIdentityFor("cms125"), {
    cmsId: "CMS125",
    mipsQualityId: "112",
  });
  assert.deepEqual(measureIdentityFor("cms122"), {
    cmsId: "CMS122",
    mipsQualityId: "001",
  });
  assert.deepEqual(measureIdentityFor("cms2v15"), {
    cmsId: "CMS2",
    mipsQualityId: "134",
  });
  assert.equal(measureIdentityFor("audiogram"), null);
  assert.equal(measureIdentityFor("hazwoper"), null);
  assert.equal(measureIdentityFor("unknown-measure"), null);
});

test("drift guard: catalog entries match MEASURE_IDENTITY, non-cms have none, and map has no extras", () => {
  const catalogIds = new Set(MEASURE_CATALOG.map((m) => m.id));

  // Reject extras in MEASURE_IDENTITY that do not exist in MEASURE_CATALOG
  for (const mapId of Object.keys(MEASURE_IDENTITY)) {
    assert.ok(
      catalogIds.has(mapId),
      `MEASURE_IDENTITY contains extra entry '${mapId}' not found in MEASURE_CATALOG`,
    );
  }

  for (const m of MEASURE_CATALOG) {
    const isCms = m.id.startsWith("cms");
    const identity = MEASURE_IDENTITY[m.id];

    if (!isCms) {
      assert.equal(
        identity,
        undefined,
        `Non-CMS measure ${m.id} must not have a MEASURE_IDENTITY entry`,
      );
      continue;
    }

    assert.ok(identity, `CMS measure ${m.id} must be present in MEASURE_IDENTITY`);
    assert.ok(identity.cmsId, `CMS measure ${m.id} must have a cmsId`);

    // Assert cmsId matches the row's policyRef CMS number (e.g. 'CMS125v14' -> 'CMS125')
    const cmsMatch = m.policyRef.match(/^(CMS\d+)/i);
    assert.ok(
      cmsMatch,
      `CMS measure ${m.id} policyRef (${m.policyRef}) must match ^(CMS\\d+)`,
    );
    const expectedCmsId = cmsMatch[1]!.toUpperCase();
    assert.equal(
      identity.cmsId,
      expectedCmsId,
      `MEASURE_IDENTITY[${m.id}].cmsId (${identity.cmsId}) must match policyRef prefix (${expectedCmsId})`,
    );

    // Parse BOTH 'MIPS Quality ID NNN' and 'MIPS N' / 'MIPS NNN', normalise to 3 digits
    const mipsMatch = m.spec.description.match(/(?:MIPS Quality ID|MIPS)\s+(\d+)/i);
    if (mipsMatch) {
      const expectedMips = mipsMatch[1]!.padStart(3, "0");
      assert.equal(
        identity.mipsQualityId,
        expectedMips,
        `MEASURE_IDENTITY[${m.id}].mipsQualityId (${identity.mipsQualityId}) must match catalog description (${expectedMips})`,
      );
    } else {
      assert.equal(
        identity.mipsQualityId,
        null,
        `CMS measure ${m.id} without MIPS description must have null mipsQualityId in MEASURE_IDENTITY`,
      );
    }
  }
});
