import { test } from "node:test";
import assert from "node:assert/strict";
import { MEASURE_CATALOG } from "./measure-catalog.ts";
import { readFileSync } from "node:fs";
import {
  CMS_ARTIFACT_LINEAGE_FOR_TEST,
  MEASURE_IDENTITY,
  ecqmIdOf,
  executedLogicFor,
  formatScoringLogic,
  measureVersionOf,
  scoringLogicOf,
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

test("measureIdentityPayloadFor names a translation only when it is routed beside CMS's artifact", () => {
  // cms137's translation (ww-2027.1) is committed under measures/derived/, so a cms137 routed both ways
  // names it, from the manifest alone...
  const committed = { label: "WorkWell translation of CMS137v15", version: "ww-2027.1", url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15", year: "2027" };
  assert.deepEqual(translationLogicFor("cms137"), committed);
  assert.deepEqual(measureIdentityPayloadFor("cms137", true, true)?.translation, committed);
  // ...and the payload a deployment with nothing allowlisted serves is exactly today's, translation unseen.
  assert.deepEqual(measureIdentityPayloadFor("cms137", true, false), measureIdentityPayloadFor("cms137", true));
  assert.deepEqual(Object.keys(measureIdentityPayloadFor("cms137", true)!).sort(), ["cmsId", "executed", "improvementNotation", "mipsQualityId"]);
  assert.deepEqual(Object.keys(measureIdentityPayloadFor("cms137", false, true)!).sort(), ["cmsId", "improvementNotation", "mipsQualityId"], "never without the official routing it rides on");

  // With the translation injected: named only when both routings hold.
  const of = () => committed;
  assert.deepEqual(measureIdentityPayloadFor("cms137", true, true, of)?.translation, committed);
  assert.equal("translation" in measureIdentityPayloadFor("cms137", false, true, of)!, false, "not official-routed: CMS's artifact is not running, so neither is its translation");
  assert.equal("translation" in measureIdentityPayloadFor("cms137", true, false, of)!, false, "not allowlisted");
});

import { readdirSync } from "node:fs";

const OFFICIAL_DIR = new URL("../../measures/official/", import.meta.url);
const committedManifests = () =>
  readdirSync(OFFICIAL_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, manifest: JSON.parse(readFileSync(new URL(`${d.name}/manifest.json`, OFFICIAL_DIR), "utf8")) as { cmsId: string; version: string; sha256: string; source: { repo: string } } }));

test("every committed CMS artifact has a pinned lineage, keyed by its own sha", () => {
  const manifests = committedManifests();
  assert.ok(manifests.length >= 9, `expected the nine vendored artifacts, found ${manifests.length}`);
  for (const { id, manifest } of manifests) {
    const pinned = CMS_ARTIFACT_LINEAGE_FOR_TEST[manifest.sha256];
    assert.ok(pinned, `${id}: no pinned lineage for ${manifest.sha256}; a re-vendor must name what the new artifact derives from`);
    assert.equal(pinned.measureId, id);
    assert.equal(pinned.ecqmId, ecqmIdOf(manifest.cmsId));
    assert.equal(pinned.version, manifest.version);
    assert.equal(pinned.contentRepo, manifest.source.repo);
    assert.match(pinned.derivedFrom, /^CMS\d+v\d+$/);
  }
  assert.equal(Object.keys(CMS_ARTIFACT_LINEAGE_FOR_TEST).length, manifests.length, "a pinned entry with no committed artifact is stale");
});

test("ecqmIdOf spells every served eCQM id with its CMS prefix, once", () => {
  assert.equal(ecqmIdOf("125FHIR"), "CMS125FHIR");
  assert.equal(ecqmIdOf("CMS125FHIR"), "CMS125FHIR");
  assert.equal(ecqmIdOf(" 2FHIR "), "CMS2FHIR");
});

const cms125Sha = "sha256:97f737fa5262fca1fbb4620e10ce286f612b87b7de4c3fc06fdfe38dfb666ac8";
const cmsRow = (extra: Record<string, unknown> = {}) => ({ official: { ecqmId: "125FHIR", version: "1.0.000", engine: "fqm-execution", artifactSha256: cms125Sha, ...extra } });
const translatedRow = { official: { kind: "derived", label: "WorkWell translation of CMS137v15", url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15", ecqmId: null, version: "ww-2027.1", engine: "fqm-execution", artifactSha256: "sha256:t" } };

test("scoringLogicOf names CMS's artifact from the row's own evidence, with its pinned lineage", () => {
  assert.deepEqual(scoringLogicOf(cmsRow()), {
    kind: "cms-artifact",
    ecqmId: "CMS125FHIR",
    version: "1.0.000",
    derivedFrom: "CMS125v14",
    status: "draft",
    statusNote: "posted for public comment Jan–Feb 2026",
  });
  // A row written before artifactSha256 was recorded falls back to the one artifact with that id and version.
  assert.equal(scoringLogicOf({ official: { ecqmId: "125FHIR", version: "1.0.000" } })?.derivedFrom, "CMS125v14");
  // An artifact this table does not pin is named, but no lineage or release state is invented for it.
  const unknown = scoringLogicOf(cmsRow({ artifactSha256: "sha256:not-vendored", version: "2.0.000" }));
  assert.equal(unknown?.kind, "cms-artifact");
  assert.equal(unknown && unknown.kind === "cms-artifact" ? unknown.derivedFrom : "x", null);
  assert.equal(unknown && unknown.kind === "cms-artifact" ? unknown.status : "x", "unknown");
});

test("scoringLogicOf names a translation by its label and never gives it a CMS eCQM id", () => {
  const logic = scoringLogicOf(translatedRow);
  assert.deepEqual(logic, {
    kind: "workwell-translation",
    label: "WorkWell translation of CMS137v15",
    version: "ww-2027.1",
    url: "urn:workwell:measure:cms137:translation",
    derivedFrom: "CMS137v15",
  });
  assert.equal("ecqmId" in (logic as object), false);
  // Even a corrupted translated row carrying an id stays a translation.
  const forged = scoringLogicOf({ official: { ...translatedRow.official, ecqmId: "137FHIR" } });
  assert.equal(forged?.kind, "workwell-translation");
  assert.equal(scoringLogicOf({ official: { ...translatedRow.official, label: "" } }), null, "no label: nothing to name it by");
});

test("scoringLogicOf is null where nothing named scored the row", () => {
  assert.equal(scoringLogicOf(null), null);
  assert.equal(scoringLogicOf({ expressionResults: [] }), null, "authored CQL");
  assert.equal(scoringLogicOf({ evaluationError: "CQL engine failure", message: "boom" }), null, "errored");
  assert.equal(scoringLogicOf({ official: { ecqmId: "125FHIR" } }), null, "no version");
  assert.equal(scoringLogicOf({ official: { version: "1.0.000" } }), null, "no id");
});

test("formatScoringLogic spells the executed identity, never the QDM id", () => {
  assert.equal(formatScoringLogic(scoringLogicOf(cmsRow())), "CMS125FHIR v1.0.000");
  assert.equal(formatScoringLogic(scoringLogicOf(translatedRow)), "WorkWell translation of CMS137v15 (ww-2027.1)");
  assert.equal(formatScoringLogic(null), null);
});

test("measureVersionOf is the version that scored the row, never the catalog record's or a library that did not run", () => {
  assert.equal(measureVersionOf("cms125", cmsRow()), "1.0.000");
  assert.equal(measureVersionOf("cms137", translatedRow), "ww-2027.1");
  // An errored official row printed the authored library's "2.0.0" before; nothing scored it.
  assert.equal(measureVersionOf("cms125", { evaluationError: "CQL engine failure", message: "boom" }), "");
  assert.equal(measureVersionOf("cms125", { official: { ecqmId: "125FHIR" } }), "", "a malformed official block");
  // A row authored CQL scored keeps the authored library's version: true on TWH, and on rows from before routing.
  assert.equal(measureVersionOf("cms125", { expressionResults: [] }), "2.0.0");
  assert.equal(measureVersionOf("audiogram", { expressionResults: [] }), "1.0.0");
  // An official-only measure has no authored library: no version, not the catalog's "v1.0".
  assert.equal(measureVersionOf("cms2", { expressionResults: [] }), "");
});

