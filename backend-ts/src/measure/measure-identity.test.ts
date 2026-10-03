import { test } from "node:test";
import assert from "node:assert/strict";
import { MEASURE_CATALOG } from "./measure-catalog.ts";
import { readFileSync } from "node:fs";
import {
  MEASURE_IDENTITY,
  executedLogicFor,
  executedLogicFromManifest,
  measureIdentityFor,
  measureIdentityPayloadFor,
  translationLogicFromManifest,
  translationLogicFor,
} from "./measure-identity.ts";

const manifestOf = (id: string) =>
  JSON.parse(readFileSync(new URL(`../../measures/official/${id}/manifest.json`, import.meta.url), "utf8")) as {
    cmsId: string;
    version: string;
    source: { repo: string };
  };

test("executedLogicFor names the FHIR artifact each Maui measure runs, read from its manifest", () => {
  const expected: Record<string, string> = {
    cms122: "CMS122v14",
    cms125: "CMS125v14",
    cms2: "CMS2v15",
    cms130: "CMS130v14",
    cms165: "CMS165v14",
    cms137: "CMS137v14",
  };
  for (const [id, qdm] of Object.entries(expected)) {
    const manifest = manifestOf(id);
    assert.deepEqual(executedLogicFor(id), {
      ecqmId: `CMS${manifest.cmsId}`,
      version: manifest.version,
      status: "draft",
      statusNote: "posted for public comment Jan–Feb 2026",
      derivedFrom: qdm,
    }, id);
  }
  // Spelled out once, so a manifest change that moved both sides together still shows up here.
  assert.deepEqual(executedLogicFor("cms125"), {
    ecqmId: "CMS125FHIR",
    version: "1.0.000",
    status: "draft",
    statusNote: "posted for public comment Jan–Feb 2026",
    derivedFrom: "CMS125v14",
  });
  assert.equal(executedLogicFor("audiogram"), null, "nothing vendored, nothing executed");
});

test("executedLogicFromManifest: an unlisted content repo is 'unknown', never assumed draft; a mismatched lineage is dropped", () => {
  const unlisted = executedLogicFromManifest("cms125", { cmsId: "125FHIR", version: "2.0.000", source: { repo: "cqframework/some-later-repo", ref: "x", path: "y", rawSha256: "z" } });
  assert.equal(unlisted?.status, "unknown");
  assert.equal(unlisted?.statusNote, null);
  assert.equal(unlisted?.version, "2.0.000");
  // The catalog row says CMS125v14; an artifact for another measure under this id must not borrow it.
  const mismatched = executedLogicFromManifest("cms125", { cmsId: "130FHIR", version: "1.0.000", source: { repo: "cqframework/dqm-content-qicore-2025", ref: "x", path: "y", rawSha256: "z" } });
  assert.equal(mismatched?.ecqmId, "CMS130FHIR");
  assert.equal(mismatched?.derivedFrom, null);
  assert.equal(executedLogicFromManifest("cms125", { cmsId: null, version: "1.0.000", source: { repo: "r", ref: "x", path: "y", rawSha256: "z" } }), null);
});

test("measureIdentityPayloadFor adds `executed` only for a routed measure, and leaves the crosswalk untouched", () => {
  const routed = measureIdentityPayloadFor("cms125", true);
  assert.equal(routed?.cmsId, "CMS125", "the chip's identity is unchanged");
  assert.equal(routed?.executed?.ecqmId, "CMS125FHIR");
  assert.equal(routed?.executed?.version, "1.0.000");
  // No key at all (not `executed: undefined`), so the authored payload is byte-identical to before.
  assert.deepEqual(measureIdentityPayloadFor("cms125", false), { cmsId: "CMS125", mipsQualityId: "112", improvementNotation: "increase" });
  assert.equal(Object.hasOwn(measureIdentityPayloadFor("cms125", false)!, "executed"), false);
  assert.equal(measureIdentityPayloadFor("audiogram", true), null);
});

test("measureIdentityFor returns identity for CMS measures and null for non-CMS measures", () => {
  assert.deepEqual(measureIdentityFor("cms125"), {
    cmsId: "CMS125",
    mipsQualityId: "112",
    improvementNotation: "increase",
  });
  assert.deepEqual(measureIdentityFor("cms122"), {
    cmsId: "CMS122",
    mipsQualityId: "001",
    improvementNotation: "decrease",
  });
  assert.deepEqual(measureIdentityFor("cms2"), {
    cmsId: "CMS2",
    mipsQualityId: "134",
    improvementNotation: "increase",
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
    // Keyed on the policy reference, not the id prefix, so a CMS row under any id shape is still checked.
    const isCms = /^CMS\d+/i.test(m.policyRef);
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

test("one source of inverse — improvementNotation 'decrease' iff numeratorMeansCompliant false", async () => {
  const { OFFICIAL_MEASURE_SEMANTICS } = await import("../wiring/official-measure-semantics.ts");
  const commonIds = Object.keys(MEASURE_IDENTITY).filter((id) => id in OFFICIAL_MEASURE_SEMANTICS);
  assert.ok(commonIds.length > 0, "must test at least one common measure");
  for (const id of commonIds) {
    const identity = MEASURE_IDENTITY[id]!;
    const semantics = OFFICIAL_MEASURE_SEMANTICS[id]!;
    assert.equal(
      identity.improvementNotation === "decrease",
      semantics.numeratorMeansCompliant === false,
      `Measure ${id} failed inverse consistency check: improvementNotation='${identity.improvementNotation}', numeratorMeansCompliant=${semantics.numeratorMeansCompliant}`,
    );
  }
});

test("translationLogicFromManifest names a translation by its own label and canonical, for the one year it covers", () => {
  const derived = { label: "WorkWell translation of CMS137v15", derivedFrom: { ecqm: "CMS137v15", packageSha256: "sha256:p" } } as never;
  assert.deepEqual(
    translationLogicFromManifest({ version: "ww-2027.1", url: "urn:workwell:measure:cms137:translation", effectivePeriod: { start: "2027-01-01", end: "2027-12-31" }, derived }),
    { label: "WorkWell translation of CMS137v15", version: "ww-2027.1", url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15", year: "2027" },
  );
  assert.equal(translationLogicFromManifest({ version: "1.0.000", url: "https://madie.cms.gov/Measure/CMS137FHIR", effectivePeriod: { start: "2026-01-01", end: "2026-12-31" } }), null, "CMS's manifest is not a translation");
  assert.equal(translationLogicFromManifest({ version: "ww-x", url: "u", effectivePeriod: { start: "2027-01-01", end: "2028-12-31" }, derived }), null, "never a span of years");
  assert.equal(translationLogicFromManifest({ version: "ww-x", url: "u", effectivePeriod: null, derived }), null, "never an undeclared year");
});

test("measureIdentityPayloadFor names a translation only when it is routed beside CMS's artifact; none is committed yet", () => {
  // C2 commits no translation, so even a routed cms137 carries no `translation` key...
  assert.equal(translationLogicFor("cms137"), null);
  assert.equal("translation" in measureIdentityPayloadFor("cms137", true, true)!, false);
  // ...and the payload a deployment with nothing allowlisted serves is exactly today's.
  assert.deepEqual(measureIdentityPayloadFor("cms137", true, false), measureIdentityPayloadFor("cms137", true));
  assert.deepEqual(Object.keys(measureIdentityPayloadFor("cms137", true)!).sort(), ["cmsId", "executed", "improvementNotation", "mipsQualityId"]);
  assert.deepEqual(Object.keys(measureIdentityPayloadFor("cms137", false, true)!).sort(), ["cmsId", "improvementNotation", "mipsQualityId"], "never without the official routing it rides on");

  // With a committed translation (injected): named only when both routings hold.
  const committed = { label: "WorkWell translation of CMS137v15", version: "ww-2027.1", url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15", year: "2027" };
  const of = () => committed;
  assert.deepEqual(measureIdentityPayloadFor("cms137", true, true, of)?.translation, committed);
  assert.equal("translation" in measureIdentityPayloadFor("cms137", false, true, of)!, false, "not official-routed: CMS's artifact is not running, so neither is its translation");
  assert.equal("translation" in measureIdentityPayloadFor("cms137", true, false, of)!, false, "not allowlisted");
});
