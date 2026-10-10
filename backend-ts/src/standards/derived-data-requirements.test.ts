/**
 * Recomputing a library's computed data requirements when WorkWell's edit changes what it reads (#782).
 *
 * The calibration runs on the COMMITTED artifacts: every library of every official artifact (and of both
 * committed translations) is its own ELM's lists already, so rewriting them from that ELM, or
 * "recomputing" against an equal surface, must give the library back byte for byte. The CMS125v15 case is
 * a hand edit of CMS's committed cms125 main-library ELM — the 1071 diagnosis branches removed, a 1285
 * procedure branch added under each side's `isProcedurePerformed`, the qualifier codes swapped for the
 * breast body-structure codes — not WorkWell's compile of CMS's CQL, which is never read here. The 1285
 * canonical below is the test's stand-in for the value set's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOfficialArtifact } from "../wiring/official-artifacts.ts";
import { recomputeDataRequirements, rewriteDeclaredLists } from "./derived-data-requirements.ts";
import { dataSurfaceDifferences, elmDataSurface } from "./elm-data-surface.ts";

type Res = Record<string, unknown>;
type B = { entry: Array<{ resource: Res }> };
/** ELM is walked and hand-edited here as plain JSON. */
type Elm = any;
const BACKEND = fileURLToPath(new URL("../../", import.meta.url));
const decode = (data: string): Elm => JSON.parse(Buffer.from(data, "base64").toString("utf8"));
const elmOf = (library: Res): Elm => decode((library["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!.data);
const librariesOf = (b: B) => b.entry.map((e) => e.resource).filter((r) => r["resourceType"] === "Library");
const mainOf = (b: B) => {
  const ref = (b.entry.find((e) => e.resource["resourceType"] === "Measure")!.resource["library"] as string[])[0];
  return librariesOf(b).find((l) => l["url"] === ref || `${String(l["url"])}|${String(l["version"])}` === ref)!;
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const VS = "http://cts.nlm.nih.gov/fhir/ValueSet/";
const VS_1071 = `${VS}2.16.840.1.113883.3.464.1003.198.12.1071`;
const VS_1285 = `${VS}2.16.840.1.113883.3.464.1003.1285`;
const QICORE = "http://hl7.org/fhir/us/qicore/StructureDefinition/";
const DRC = "http://hl7.org/fhir/StructureDefinition/cqf-directReferenceCode";

/** The value-set URLs a library's lists name, read as fqm reads them, and the ones its ELM declares. */
function namedValueSets(library: Res): Set<string> {
  const out = new Set<string>();
  for (const r of (library["relatedArtifact"] as Res[] | undefined) ?? []) {
    if (r["type"] === "depends-on" && String(r["resource"]).includes("ValueSet")) out.add(String(r["resource"]));
  }
  for (const d of (library["dataRequirement"] as Res[] | undefined) ?? []) for (const f of (d["codeFilter"] as Res[] | undefined) ?? []) if (f["valueSet"]) out.add(String(f["valueSet"]));
  return out;
}
const declaredValueSets = (elm: Elm) => new Set<string>((elm.library.valueSets?.def ?? []).map((d: { id: string }) => d.id));

// ---- calibration on the committed artifacts -------------------------------------------------------------

function committedBundles(): Array<[string, B]> {
  const out: Array<[string, B]> = [];
  for (const root of ["official", "derived"]) {
    const dir = join(BACKEND, "measures", root);
    for (const id of readdirSync(dir)) {
      if (!existsSync(join(dir, id, "bundle.json"))) continue;
      const artifact = root === "official" ? loadOfficialArtifact(id) : null;
      const bundle = artifact ? (artifact.bundle as unknown as B) : (JSON.parse(readFileSync(join(dir, id, "bundle.json"), "utf8")) as B);
      out.push([`${root}/${id}`, bundle]);
    }
  }
  return out;
}

test("calibration: every committed library's value-set and code-system depends-on entries and direct-reference codes ARE its ELM's, as rewritten here", () => {
  const bundles = committedBundles();
  assert.ok(bundles.filter(([id]) => id.startsWith("official/")).length >= 9, "all nine official artifacts are read");
  let libraries = 0;
  for (const [id, bundle] of bundles) {
    for (const library of librariesOf(bundle)) {
      libraries++;
      const elm = elmOf(library);
      const what = `${id} ${String(library["name"])}`;
      // Byte for byte, so key order and list positions are MADiE's too.
      assert.equal(JSON.stringify(rewriteDeclaredLists(library, elm)), JSON.stringify(library), `${what}: the rewrite reproduces MADiE's lists`);
      assert.equal(JSON.stringify(recomputeDataRequirements(library, elm, elm)), JSON.stringify(library), `${what}: an equal surface is a no-op`);
    }
  }
  assert.ok(libraries >= 80, `${libraries} libraries`);
});

// ---- the CMS125v15 edit, by hand on CMS's committed ELM -------------------------------------------------

const cms125 = loadOfficialArtifact("cms125")!.bundle as unknown as B;
const main125 = mainOf(cms125);
const cmsElm125 = elmOf(main125);
const UNSPECIFIED = "Unilateral Mastectomy, Unspecified Laterality";
const defOf = (elm: Elm, name: string) => elm.library.statements.def.find((d: { name: string }) => d.name === name);

/** CMS's committed cms125 main ELM with CMS125v15's change to what it reads (the issue's table). */
function v15Elm(): Elm {
  const elm = clone(cmsElm125);
  const lib = elm.library;
  lib.valueSets.def = lib.valueSets.def.filter((d: { name: string }) => d.name !== UNSPECIFIED);
  lib.valueSets.def.push({ name: "Unilateral Mastectomy", id: VS_1285, accessLevel: "Public" });
  const code = (name: string, id: string) => ({ name, id, display: name, accessLevel: "Public", codeSystem: { name: "SNOMEDCT" } });
  lib.codes.def = [code("Entire left breast (body structure)", "361716006"), code("Entire right breast (body structure)", "361715005")];
  // The unspecified-laterality branch's query, kept to build the procedure branch in its image.
  let template: Elm;
  for (const side of ["Left", "Right"]) {
    const verified = defOf(elm, `${side} Mastectomy Diagnosis`).expression.source[0].expression;
    assert.equal(verified.name, "verified");
    const union = verified.operand[0];
    const kept = union.operand.filter((o: unknown) => !JSON.stringify(o).includes(UNSPECIFIED));
    template ??= union.operand.find((o: unknown) => JSON.stringify(o).includes(UNSPECIFIED));
    assert.equal(kept.length, 1, `${side}: one diagnosis branch is removed`);
    verified.operand[0] = kept[0];
  }
  for (const side of ["Left", "Right"]) {
    const performed = defOf(elm, `${side} Mastectomy Procedure`).expression.source[0].expression;
    assert.equal(performed.name, "isProcedurePerformed");
    const sideRetrieve = performed.operand[0];
    assert.equal(sideRetrieve.type, "Retrieve");
    const branch = JSON.parse(
      JSON.stringify(template)
        .replaceAll("UnilateralMastectomyDiagnosis", "UnilateralMastectomyProcedure")
        .replaceAll(`${side === "Left" ? "Right" : "Left"} (qualifier value)`, `${side} (qualifier value)`)
        .replaceAll(`${side} (qualifier value)`, `Entire ${side.toLowerCase()} breast (body structure)`),
    );
    branch.source[0].expression = { ...clone(sideRetrieve), codes: { name: "Unilateral Mastectomy", preserve: true, type: "ValueSetRef" } };
    performed.operand[0] = { type: "Union", operand: [sideRetrieve, branch] };
  }
  return elm;
}

test("an equal surface keeps CMS's lists byte for byte, even lists its ELM would not reproduce", () => {
  // Not CMS's content: an extra value-set entry no declaration accounts for. The recompute must not touch
  // a library whose reads did not change, so it is still there.
  const odd = clone(main125);
  (odd["relatedArtifact"] as Res[]).push({ type: "depends-on", display: "Value set Extra", resource: `${VS}extra` });
  assert.notEqual(JSON.stringify(rewriteDeclaredLists(odd, cmsElm125)), JSON.stringify(odd), "a rewrite would drop it");
  assert.equal(JSON.stringify(recomputeDataRequirements(odd, cmsElm125, clone(cmsElm125))), JSON.stringify(odd));
});

const NEW_PROCEDURE = {
  type: "Procedure",
  profile: [`${QICORE}qicore-procedure`],
  mustSupport: ["code", "bodySite"],
  codeFilter: [{ path: "code", valueSet: VS_1285 }],
};

test("CMS125v15: the 1071 entries go, a 1285 entry per new retrieve is appended in MADiE's shape, and every other entry is CMS's", () => {
  const ours = v15Elm();
  assert.ok(dataSurfaceDifferences(elmDataSurface(cmsElm125), elmDataSurface(ours)).length > 0, "the edit changes what the library reads");
  const before = JSON.stringify(main125);
  const out = recomputeDataRequirements(main125, cmsElm125, ours);
  assert.equal(JSON.stringify(main125), before, "CMS's resource is not modified");
  assert.deepEqual(Object.keys(out), Object.keys(main125), "no key moves");

  const cmsEntries = main125["dataRequirement"] as Res[];
  const is1071 = (e: Res) => JSON.stringify(e).includes(VS_1071);
  assert.equal(cmsEntries.filter(is1071).length, 4, "CMS lists the four 1071 retrieves, two per side");
  assert.deepEqual(out["dataRequirement"], [...cmsEntries.filter((e) => !is1071(e)), NEW_PROCEDURE, NEW_PROCEDURE]);

  // relatedArtifact: Library entries as they were, then the code system, then valueSets.def in order.
  const related = out["relatedArtifact"] as Res[];
  const libs = (main125["relatedArtifact"] as Res[]).filter((r) => String(r["display"]).startsWith("Library "));
  assert.deepEqual(related, [
    ...libs,
    { type: "depends-on", display: "Code system SNOMEDCT", resource: "http://snomed.info/sct" },
    ...ours.library.valueSets.def.map((d: { name: string; id: string }) => ({ type: "depends-on", display: `Value set ${d.name}`, resource: d.id })),
  ]);

  // The direct-reference codes are the new ones, by name, ahead of the options extension as before.
  assert.deepEqual(out["extension"], [
    { url: DRC, valueCoding: { system: "http://snomed.info/sct", code: "361716006", display: "Entire left breast (body structure)" } },
    { url: DRC, valueCoding: { system: "http://snomed.info/sct", code: "361715005", display: "Entire right breast (body structure)" } },
    (main125["extension"] as Res[])[2],
  ]);

  // What fqm collects is exactly what the ELM declares: no 1071, and 1285.
  assert.deepEqual([...namedValueSets(out)].sort(), [...declaredValueSets(ours)].sort());
  assert.ok(namedValueSets(main125).has(VS_1071) && !namedValueSets(out).has(VS_1071));
});

test("the removed entry is matched by type, profile and code filter; with none to remove, the recompute refuses", () => {
  const stripped = { ...main125, dataRequirement: (main125["dataRequirement"] as Res[]).filter((e) => !JSON.stringify(e).includes(VS_1071)) };
  assert.throws(
    () => recomputeDataRequirements(stripped, cmsElm125, v15Elm()),
    new RegExp(
      "CMS125FHIRBreastCancerScreen 1\\.0\\.000: CMS's ELM retrieves Condition \\(.*qicore-condition-encounter-diagnosis, value set .*198\\.12\\.1071\\), which WorkWell's does not, " +
        "but no dataRequirement entry describes that retrieve",
    ),
  );
  // An entry for the same value set under another profile does not describe it.
  const otherProfile = clone(main125);
  for (const e of otherProfile["dataRequirement"] as Res[]) if (JSON.stringify(e).includes(VS_1071)) e["profile"] = [`${QICORE}qicore-condition`];
  assert.throws(() => recomputeDataRequirements(otherProfile, cmsElm125, v15Elm()), /no dataRequirement entry describes that retrieve/);
  // Nor one with a second code filter.
  const twoFilters = clone(main125);
  for (const e of twoFilters["dataRequirement"] as Res[]) if (JSON.stringify(e).includes(VS_1071)) (e["codeFilter"] as Res[]).push({ path: "bodySite", valueSet: VS_1071 });
  assert.throws(() => recomputeDataRequirements(twoFilters, cmsElm125, v15Elm()), /no dataRequirement entry describes that retrieve/);
});

test("refused until a translation needs it: a code retrieve, a value set of another library, another comparator, a versioned declaration", () => {
  const withRetrieve = (codes: unknown, codeComparator = "in") => {
    const elm = v15Elm();
    const retrieve = { type: "Retrieve", dataType: "{http://hl7.org/fhir}Procedure", templateId: `${QICORE}qicore-procedure`, codeProperty: "code", codeComparator, codes };
    elm.library.statements.def.push({ name: "Extra", context: "Patient", expression: { type: "Exists", operand: retrieve } });
    return elm;
  };
  assert.throws(
    () => recomputeDataRequirements(main125, cmsElm125, withRetrieve({ type: "ToList", operand: { type: "CodeRef", name: "Entire left breast (body structure)" } }, "~")),
    /a retrieve only WorkWell's ELM has \(.*361716006.*\) filters by a code, not a value set, which is not supported until a translation needs it/,
  );
  assert.throws(
    () => recomputeDataRequirements(main125, cmsElm125, withRetrieve({ type: "ValueSetRef", libraryName: "Hospice", name: "Hospice care ambulatory" })),
    /filters by a value set declared in another library/,
  );
  assert.throws(() => recomputeDataRequirements(main125, cmsElm125, withRetrieve({ type: "ValueSetRef", name: "Unilateral Mastectomy" }, "~")), /compares its value set by '~', not 'in'/);
  const versioned = v15Elm();
  versioned.library.valueSets.def[0].version = "20260514";
  assert.throws(() => recomputeDataRequirements(main125, cmsElm125, versioned), /declares value set 'Bilateral Mastectomy' with a version/);
  const versionedSystem = v15Elm();
  versionedSystem.library.codeSystems.def[0].version = "2026-03";
  assert.throws(() => recomputeDataRequirements(main125, cmsElm125, versionedSystem), /declares code system 'SNOMEDCT' with a version/);
});

// ---- the appended entry's mustSupport, and lists the library did not have --------------------------------

/** A minimal ELM library: one value set, the given defines. */
function tinyElm(defs: unknown[], valueSets = [{ name: "A", id: `${VS}a` }]): Elm {
  return { library: { identifier: { id: "Tiny", version: "1" }, valueSets: { def: valueSets }, statements: { def: defs } } };
}
const retrieveA = () => ({ type: "Retrieve", dataType: "{http://hl7.org/fhir}Encounter", templateId: `${QICORE}qicore-encounter`, codeProperty: "type", codeComparator: "in", codes: { type: "ValueSetRef", name: "A" } });
const prop = (path: string, scope: string) => ({ type: "Property", path, scope });
const define = (name: string, expression: unknown) => ({ name, context: "Patient", expression });
const entryOf = (mustSupport?: string[]) => ({
  type: "Encounter",
  profile: [`${QICORE}qicore-encounter`],
  ...(mustSupport ? { mustSupport } : {}),
  codeFilter: [{ path: "type", valueSet: `${VS}a` }],
});
const appended = (defs: unknown[]) => recomputeDataRequirements<Res>({ resourceType: "Library", name: "Tiny", version: "1", content: [] }, tinyElm([]), tinyElm(defs))["dataRequirement"];

test("mustSupport: the code path, then what the queries read off the alias the rows reach, through functions but not a union", () => {
  // Directly a source: every path read off the alias, and every prefix of a chain, deduplicated.
  const chain = { type: "Property", path: "value", source: prop("status", "E") };
  assert.deepEqual(
    appended([define("D", { type: "Query", source: [{ alias: "E", expression: retrieveA() }], where: { type: "And", operand: [prop("period", "E"), chain, prop("period", "E")] } })]),
    [entryOf(["type", "period", "status", "status.value"])],
  );
  // Through a fluent function's operand; an AliasRef source counts as the alias.
  assert.deepEqual(
    appended([define("D", { type: "Query", source: [{ alias: "E", expression: { type: "FunctionRef", name: "isEncounterPerformed", operand: [retrieveA()] } }], where: { type: "Property", path: "period", source: { type: "AliasRef", name: "E" } } })]),
    [entryOf(["type", "period"])],
  );
  // Under a union, only the code path (MADiE's CMS125 unspecified-laterality conditions).
  assert.deepEqual(
    appended([define("D", { type: "Query", source: [{ alias: "E", expression: { type: "Union", operand: [retrieveA(), retrieveA()] } }], where: prop("period", "E") })]),
    [entryOf(["type"]), entryOf(["type"])],
  );
  // A single-source query with no return hands its rows on: the inner alias's paths, then the outer's.
  const inner = { type: "Query", source: [{ alias: "I", expression: retrieveA() }], where: prop("status", "I") };
  assert.deepEqual(appended([define("D", { type: "Query", source: [{ alias: "O", expression: inner }], where: prop("period", "O") })]), [entryOf(["type", "status", "period"])]);
  // ...but not one with a return clause.
  assert.deepEqual(
    appended([define("D", { type: "Query", source: [{ alias: "O", expression: { ...inner, return: { expression: prop("id", "I") } } }], where: prop("period", "O") })]),
    [entryOf(["type", "status", "id"])],
  );
  // A relationship's alias is read in its such-that; a retrieve in a where clause reaches no alias.
  assert.deepEqual(
    appended([
      define("D", {
        type: "Query",
        source: [{ alias: "P", expression: { type: "ExpressionRef", name: "Other" } }],
        relationship: [{ type: "With", alias: "W", expression: retrieveA(), suchThat: prop("period", "W") }],
        where: { type: "Exists", operand: retrieveA() },
      }),
    ]),
    [entryOf(["type", "period"]), entryOf(["type"])],
  );
});

test("a list the library did not have is created where MADiE writes it; an entry with no codes is type and profile only", () => {
  const library: Res = { resourceType: "Library", id: "Tiny", url: "u", name: "Tiny", version: "1", type: {}, parameter: [], content: [] };
  const patient = { type: "Retrieve", dataType: "{http://hl7.org/fhir}Patient", templateId: `${QICORE}qicore-patient` };
  const codeSystems = { def: [{ name: "SNOMEDCT", id: "http://snomed.info/sct" }, { name: "Other", id: "http://other" }] };
  const codes = { def: [{ name: "Here", id: "1", codeSystem: { name: "SNOMEDCT" } }, { name: "There", id: "2", codeSystem: { name: "X", libraryName: "QICoreCommon" } }] };
  const ours = { library: { ...tinyElm([define("Patient", { type: "SingletonFrom", operand: patient })]).library, codeSystems, codes } };
  const out = recomputeDataRequirements(library, tinyElm([]), ours);
  assert.deepEqual(Object.keys(out), ["resourceType", "id", "extension", "url", "name", "version", "type", "relatedArtifact", "parameter", "dataRequirement", "content"]);
  assert.deepEqual(out["dataRequirement"], [{ type: "Patient", profile: [`${QICORE}qicore-patient`] }]);
  // A code on another library's code system is not this library's direct-reference code (MADiE leaves
  // CumulativeMedicationDuration's QICoreCommon-system codes out).
  assert.deepEqual(out["extension"], [{ url: DRC, valueCoding: { system: "http://snomed.info/sct", code: "1", display: "Here" } }]);
  assert.deepEqual(out["relatedArtifact"], [
    { type: "depends-on", display: "Code system SNOMEDCT", resource: "http://snomed.info/sct" },
    { type: "depends-on", display: "Code system Other", resource: "http://other" },
    { type: "depends-on", display: "Value set A", resource: `${VS}a` },
  ]);
  // A depends-on entry fqm would read as a value set is replaced whatever its display; a list left empty goes.
  const stale: Res = { ...library, relatedArtifact: [{ type: "depends-on", display: "Library X", resource: "http://x/Library/X" }, { type: "depends-on", display: "VS", resource: `${VS}gone` }], extension: [{ url: DRC, valueCoding: {} }] };
  const none = recomputeDataRequirements(stale, tinyElm([]), { library: { identifier: { id: "Tiny", version: "1" }, statements: { def: [] } } });
  assert.deepEqual(none["relatedArtifact"], [{ type: "depends-on", display: "Library X", resource: "http://x/Library/X" }]);
  assert.equal(none["extension"], undefined);
});
