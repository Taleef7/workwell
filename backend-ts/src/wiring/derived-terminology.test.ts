/**
 * A committed WorkWell translation's TERMINOLOGY, read from the real sidecars (decision 3, D7/D8).
 *
 * `derived-artifacts.test.ts` checks everything the committed files can decide, and stubs the sidecar as
 * present because it is gitignored and `pnpm test` has none. This file is the other half: the codes the
 * translation actually runs on, vendored from VSAC at the release its manifest names, compared with CMS's
 * sidecar for the same measure. It needs both sidecars, so each translation's test skips without them and
 * this file is listed in CI's `official-cases` job, where both are vendored and a missing one FAILS
 * (`WORKWELL_REQUIRE_OFFICIAL_TERMINOLOGY`) instead of skipping into a green run.
 *
 * The checks are one pure function, exercised on synthetic sidecars below, so every refusal has teeth while
 * no translation is committed; the per-translation test only feeds it the real files and then asks the
 * router itself, unstubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { officialRoutingProblems } from "./executor-router.ts";
import { loadDerivedArtifact, loadOfficialArtifact, type OfficialArtifact, type OfficialManifest } from "./official-artifacts.ts";
import { oidFromValueSetUrl, requiredOids, type ExpandedCode } from "./official-executor-adapter.ts";
import { absentValueSets, cappedExpansions, loadOfficialTerminology } from "./official-terminology.ts";

const DERIVED_DIR = fileURLToPath(new URL("../../measures/derived/", import.meta.url));
const OFFICIAL_DIR = fileURLToPath(new URL("../../measures/official/", import.meta.url));

/**
 * The VSAC release a translation for each measurement year must be expanded at. Keyed by year rather than
 * held as one constant, so a translation for a new year fails here until its release is pinned on purpose
 * instead of passing against the previous year's.
 */
const VSAC_RELEASE_FOR_YEAR: Readonly<Record<string, string>> = {
  "2027": "http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14",
};

/** Which value sets' codes differ between two sidecars, and how many codes were added and removed in all. */
interface ChangedValueSets {
  oids: string[];
  added: number;
  removed: number;
}

/**
 * Per translation, the value sets whose CODES differ from CMS's sidecar for the same measure. Pinned, not
 * computed, so a re-vendor that moves any code — a release that changed under the same name, a set that
 * quietly kept CMS's 2026 expansion — fails here and has to be explained in review.
 *
 * A translation with no entry fails with the record its build computed, so a new one is pinned after review,
 * never by default.
 *
 * cms137 (ww-2027.1): CMS137 v14 → v15 is a value-set-only change, and these are the ten sets the
 * eCQM Update 2026-05-14 release moved — the same ten an independent read of the raw VSAC dump found before
 * the translation existed. +43/−13 is a NET of 30, which is why the sidecar holds 976 codes to CMS's 946.
 */
const EXPECTED_CHANGED_SETS: Readonly<Record<string, ChangedValueSets>> = {
  cms137: {
    oids: [
      "2.16.840.1.113762.1.4.1029.206", // Intensive Care Unit
      "2.16.840.1.113883.3.464.1003.101.12.1001", // Office Visit
      "2.16.840.1.113883.3.464.1003.101.12.1080", // Telephone Visits
      "2.16.840.1.113883.3.464.1003.101.12.1089", // Virtual Encounter
      "2.16.840.1.113883.3.464.1003.106.12.1001", // Substance Use Disorder
      "2.16.840.1.113883.3.464.1003.106.12.1005", // Substance Use Disorder Treatment
      "2.16.840.1.113883.3.464.1003.1149", // SUD Long Acting Medication
      "2.16.840.1.113883.3.464.1003.1156", // SUD Long Acting Medication Administration
      "2.16.840.1.113883.3.526.3.1496", // Psych Visit Psychotherapy
      "2.16.840.1.113883.3.666.5.307", // Encounter Inpatient
    ],
    added: 43,
    removed: 13,
  },
};

interface SidecarValueSet {
  codes: ExpandedCode[];
  /** `expansion.total` as the source declared it; more than `codes.length` means the expansion was capped. */
  declaredTotal: number | null;
}
type SidecarIndex = ReadonlyMap<string, SidecarValueSet>;

/**
 * Every directory under `root` holding a manifest.json, except the QI-Core model info. NOT filtered by the
 * catalog-id rule: a translation committed under a name the loader refuses must reach the per-translation
 * test and fail its load assertion, rather than vanish from this list and leave the file green.
 */
function discoverTranslations(root: string): string[] {
  return readdirSync(root)
    .filter((name) => name !== "_modelinfo")
    .filter((name) => statSync(join(root, name)).isDirectory() && existsSync(join(root, name, "manifest.json")))
    .sort();
}

/**
 * A sidecar's value sets by OID, keyed by the rule `verifyTerminology` uses (the OID re-derived from the
 * canonical, else the recorded `oid`), so this test and the runtime can never read one set under two keys.
 * An entry without a codes array is skipped there too, and so reads here as absent.
 */
function indexSidecar(raw: string): SidecarIndex {
  const parsed = JSON.parse(raw) as {
    valueSets?: Array<{ url?: unknown; oid?: unknown; declaredTotal?: unknown; codes?: unknown }>;
  };
  const index = new Map<string, SidecarValueSet>();
  for (const valueSet of parsed.valueSets ?? []) {
    if (!Array.isArray(valueSet.codes)) continue;
    const oid = typeof valueSet.url === "string" ? oidFromValueSetUrl(valueSet.url) : typeof valueSet.oid === "string" ? valueSet.oid : null;
    if (oid === null) continue;
    index.set(oid, {
      codes: (valueSet.codes as ExpandedCode[]).map((code) => ({ system: code.system, code: code.code })),
      declaredTotal: typeof valueSet.declaredTotal === "number" ? valueSet.declaredTotal : null,
    });
  }
  return index;
}

const codeKey = (code: ExpandedCode): string => `${code.system}|${code.code}`;

/**
 * The value sets whose CODE SETS differ between two sidecars, by set difference — never by count. A release
 * that retires one code and adds another leaves the count unchanged and still changes who is in the
 * measure, and a sidecar that lists a code twice has not gained one. A set present on one side only counts
 * every code as added or removed. `oids` is sorted so two records compare by value.
 */
function changedValueSets(from: SidecarIndex, to: SidecarIndex): ChangedValueSets {
  const oids: string[] = [];
  let added = 0;
  let removed = 0;
  for (const oid of [...new Set([...from.keys(), ...to.keys()])].sort()) {
    const before = new Set((from.get(oid)?.codes ?? []).map(codeKey));
    const after = new Set((to.get(oid)?.codes ?? []).map(codeKey));
    const plus = [...after].filter((key) => !before.has(key)).length;
    const minus = [...before].filter((key) => !after.has(key)).length;
    if (plus + minus === 0) continue;
    oids.push(oid);
    added += plus;
    removed += minus;
  }
  return { oids, added, removed };
}

interface TranslationTerminology {
  id: string;
  manifest: OfficialManifest;
  /** `sha256:` of the translation sidecar's bytes, as every pin is written. */
  sidecarSha256: string;
  /** The value sets the translation's ELM declares (`requiredOids`), de-duplicated. */
  required: readonly string[];
  translation: SidecarIndex;
  /** CMS's sidecar for the same measure: the `had` side of every completion record. */
  official: SidecarIndex;
  expectedChanged: ChangedValueSets | undefined;
}

/**
 * Everything wrong with one translation's terminology, as sentences. Pure, so each refusal is proved on a
 * synthetic sidecar while nothing is committed.
 */
function terminologyProblems(input: TranslationTerminology): string[] {
  const { id, manifest, sidecarSha256, required, translation, official, expectedChanged } = input;
  const pin = manifest.terminology;
  if (!pin) return [`${id}: the translation's manifest records no terminology pin`];
  const problems: string[] = [];

  // The bytes the router (D8) and both check records (D7) were computed against.
  if (sidecarSha256 !== pin.sha256) {
    problems.push(`${id}: the translation's sidecar hashes to ${sidecarSha256}, but its manifest pins ${pin.sha256}`);
  }

  // A reader that found nothing would make every per-set check below pass vacuously.
  if (required.length === 0) problems.push(`${id}: the translation's ELM declares no value set — the reader is broken, not the translation`);
  for (const oid of required) {
    const valueSet = translation.get(oid);
    if (!valueSet) problems.push(`${id}: required value set ${oid} is absent from the translation's sidecar`);
    else if (valueSet.codes.length === 0) problems.push(`${id}: required value set ${oid} is empty in the translation's sidecar`);
    else if (valueSet.declaredTotal !== null && valueSet.codes.length < valueSet.declaredTotal) {
      problems.push(`${id}: required value set ${oid} is truncated: ${valueSet.codes.length} of the ${valueSet.declaredTotal} codes its source declared`);
    }
  }
  if (pin.truncated.length > 0) {
    problems.push(`${id}: the translation's manifest records truncated expansions (${pin.truncated.map((cap) => cap.oid).join(", ")})`);
  }

  // The release is what makes a 2027 translation score 2027 codes; the router checks only that one is named.
  const year = manifest.effectivePeriod?.start?.slice(0, 4) ?? "?";
  const release = VSAC_RELEASE_FOR_YEAR[year];
  if (!release) {
    problems.push(`${id}: no VSAC release is pinned for ${year} translations in this test`);
  } else if (pin.completion?.manifest !== release) {
    problems.push(`${id}: expanded at ${pin.completion?.manifest ?? "no named release"}, but a ${year} translation is expanded at ${release}`);
  }

  // Every declared set must have been re-expanded at that release. One without a record may still be
  // carrying CMS's 2026 codes, which a 2027 translation must never score with.
  const completion = pin.completion?.valueSets ?? [];
  const completed = new Set(completion.map((entry) => entry.oid));
  for (const oid of required) {
    if (!completed.has(oid)) problems.push(`${id}: required value set ${oid} has no completion record — nothing shows it was re-expanded at the release`);
  }
  for (const entry of completion) {
    if (entry.reason !== "release") problems.push(`${id}: the completion of ${entry.oid} has reason '${entry.reason ?? "capped"}', not 'release'`);
    const now = translation.get(entry.oid)?.codes.length;
    if (entry.now !== now) problems.push(`${id}: the completion of ${entry.oid} records now=${entry.now}, but the translation's sidecar holds ${now ?? "no such set"}`);
    const had = official.get(entry.oid)?.codes.length ?? 0;
    if (entry.had !== had) problems.push(`${id}: the completion of ${entry.oid} records had=${entry.had}, but CMS's sidecar holds ${had}`);
    if (entry.declaredTotal !== null && entry.declaredTotal > entry.now) {
      problems.push(`${id}: the completion of ${entry.oid} is truncated: ${entry.now} of the ${entry.declaredTotal} codes the release declared`);
    }
  }

  const changed = changedValueSets(official, translation);
  if (!expectedChanged) {
    problems.push(`${id}: no EXPECTED_CHANGED_SETS entry. This build differs from CMS's sidecar by ${JSON.stringify(changed)}; review every set, then pin it`);
  } else {
    const pinned = { oids: [...expectedChanged.oids].sort(), added: expectedChanged.added, removed: expectedChanged.removed };
    if (JSON.stringify(changed) !== JSON.stringify(pinned)) {
      problems.push(`${id}: the code sets that differ from CMS's are ${JSON.stringify(changed)}, but ${JSON.stringify(pinned)} is pinned`);
    }
  }

  // Every recorded check, not only the two the router requires: a stale record of any check is a claim
  // about an artifact that is no longer the one committed.
  const oracles = manifest.derived?.oracles ?? [];
  if (oracles.length === 0) problems.push(`${id}: the translation records no check at all`);
  for (const oracle of oracles) {
    if (oracle.ranAgainst.artifactSha256 !== manifest.sha256 || oracle.ranAgainst.terminologySha256 !== pin.sha256) {
      problems.push(
        `${id}: the '${oracle.name}' check ran against ${oracle.ranAgainst.artifactSha256} / ${oracle.ranAgainst.terminologySha256}, ` +
          `not the committed ${manifest.sha256} / ${pin.sha256}`,
      );
    }
  }
  return problems;
}

const sha256 = (raw: string): string => `sha256:${createHash("sha256").update(raw).digest("hex")}`;

// ---- the helpers, on synthetic sidecars ---------------------------------------------------------------

const SCT = "http://snomed.info/sct";
const set = (...codes: string[]): SidecarValueSet => ({ codes: codes.map((code) => ({ system: SCT, code })), declaredTotal: codes.length });
const index = (entries: Record<string, SidecarValueSet>): SidecarIndex => new Map(Object.entries(entries));

test("changedValueSets compares CODE SETS: a one-in-one-out swap is a change, a reorder or a duplicate is not", () => {
  const cms = index({ "1.1": set("a", "x"), "1.2": set("p", "q") });
  assert.deepEqual(changedValueSets(cms, index({ "1.1": set("x", "a", "a"), "1.2": set("q", "p") })), { oids: [], added: 0, removed: 0 });
  // Same count on both sides — exactly what a count comparison cannot see.
  assert.deepEqual(changedValueSets(cms, index({ "1.1": set("a", "b"), "1.2": set("p", "q") })), { oids: ["1.1"], added: 1, removed: 1 });
  // A code is its system AND its value.
  const otherSystem = { codes: [{ system: "http://loinc.org", code: "a" }, { system: SCT, code: "x" }], declaredTotal: 2 };
  assert.deepEqual(changedValueSets(cms, index({ "1.1": otherSystem, "1.2": set("p", "q") })), { oids: ["1.1"], added: 1, removed: 1 });
});

test("changedValueSets totals across sets, and a set on one side only is all added or all removed", () => {
  const cms = index({ "1.1": set("a"), "1.3": set("z", "y") });
  const translated = index({ "1.1": set("a", "b", "c"), "1.2": set("n") });
  assert.deepEqual(changedValueSets(cms, translated), { oids: ["1.1", "1.2", "1.3"], added: 3, removed: 2 });
});

test("indexSidecar keys a set by the OID in its canonical, version stripped, as the runtime does", () => {
  const raw = JSON.stringify({
    catalogId: "cms137",
    valueSets: [
      { url: "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.1|20260514", oid: "not-this", declaredTotal: 2, codes: [{ system: SCT, code: "a" }, { system: SCT, code: "b" }] },
      { oid: "2.16.2", codes: [{ system: SCT, code: "c" }] },
      { url: "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.3", declaredTotal: 1 },
    ],
  });
  const read = indexSidecar(raw);
  assert.deepEqual([...read.keys()], ["2.16.1", "2.16.2"], "a set with no codes array reads as absent, as verifyTerminology skips it");
  assert.equal(read.get("2.16.1")?.declaredTotal, 2);
  assert.equal(read.get("2.16.2")?.declaredTotal, null);
});

test("discovery finds a translation in a directory shaped like measures/derived/, and only a translation", () => {
  const root = mkdtempSync(join(tmpdir(), "derived-discovery-"));
  writeFileSync(join(root, "NOTICE.md"), "");
  // The model info is excluded by NAME, even if it ever carried a manifest.
  mkdirSync(join(root, "_modelinfo"));
  writeFileSync(join(root, "_modelinfo", "manifest.json"), "{}");
  mkdirSync(join(root, "cms137"));
  writeFileSync(join(root, "cms137", "manifest.json"), "{}");
  writeFileSync(join(root, "cms137", "bundle.json"), "{}");
  // A folder without a manifest is not a translation.
  mkdirSync(join(root, "cms2"));
  // A misnamed translation is FOUND, so its load assertion fails rather than the file staying green.
  mkdirSync(join(root, "CMS165"));
  writeFileSync(join(root, "CMS165", "manifest.json"), "{}");
  assert.deepEqual(discoverTranslations(root), ["CMS165", "cms137"]);
});

test("discovery reads the real measures/derived/", () => {
  assert.ok(existsSync(join(DERIVED_DIR, "_modelinfo")), "pointed at the directory the translations are committed in");
  assert.doesNotThrow(() => discoverTranslations(DERIVED_DIR));
});

// ---- the pure check, on a synthetic translation -------------------------------------------------------

const RELEASE_2027 = "http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14";
const ARTIFACT = `sha256:${"8".repeat(64)}`;
const TERMINOLOGY = `sha256:${"7".repeat(64)}`;
const CMS = index({ "1.1": set("a", "x"), "1.3": set("z") });
// 1.1 swaps x for b (one in, one out), 1.2 is new in 2027, 1.3 was dropped.
const TRANSLATED = index({ "1.1": set("a", "b"), "1.2": set("c") });

function fitManifest(): OfficialManifest {
  // A fresh object per record, so a test that stales one check's record leaves the other's intact.
  const ranAgainst = () => ({ artifactSha256: ARTIFACT, terminologySha256: TERMINOLOGY });
  return {
    catalogId: "cms137",
    sha256: ARTIFACT,
    effectivePeriod: { start: "2027-01-01", end: "2027-12-31" },
    terminology: {
      file: "terminology.json",
      valueSets: 2,
      codes: 3,
      truncated: [],
      sha256: TERMINOLOGY,
      completion: {
        source: "vsac",
        manifest: RELEASE_2027,
        valueSets: [
          { oid: "1.1", reason: "release", had: 2, now: 2, declaredTotal: 2 },
          { oid: "1.2", reason: "release", had: 0, now: 1, declaredTotal: 1 },
        ],
      },
    },
    derived: {
      oracles: [
        { name: "cypress-deck", inputSha256: "sha256:c", period: { start: "2025-01-01", end: "2025-12-31" }, agree: 36, total: 36, result: "pass", ranAgainst: ranAgainst() },
        { name: "terminology-equivalence", inputSha256: "sha256:f", period: { start: "2027-01-01", end: "2027-12-31" }, agree: 28, total: 28, result: "pass", ranAgainst: ranAgainst() },
      ],
    },
  } as unknown as OfficialManifest;
}

const fit = (): TranslationTerminology => ({
  id: "cms137",
  manifest: fitManifest(),
  sidecarSha256: TERMINOLOGY,
  required: ["1.1", "1.2"],
  translation: TRANSLATED,
  official: CMS,
  // Unsorted on purpose: the pinned record is a set of OIDs.
  expectedChanged: { oids: ["1.3", "1.1", "1.2"], added: 2, removed: 2 },
});

/** A fit translation with one thing changed, and the sentence that must result. */
function refused(change: (input: TranslationTerminology) => void, pattern: RegExp): void {
  const input = fit();
  change(input);
  const problems = terminologyProblems(input);
  assert.ok(problems.some((p) => pattern.test(p)), `expected ${pattern} in ${JSON.stringify(problems, null, 1)}`);
}
const terminologyOf = (input: TranslationTerminology) => input.manifest.terminology!;
const completionOf = (input: TranslationTerminology) => terminologyOf(input).completion!;

test("a fit translation's terminology raises no problem", () => {
  assert.deepEqual(terminologyProblems(fit()), []);
});

test("the sidecar must be the pinned bytes, and hold every declared set complete", () => {
  refused((i) => { i.sidecarSha256 = `sha256:${"0".repeat(64)}`; }, /sidecar hashes to sha256:0+, but its manifest pins/);
  refused((i) => { i.required = []; }, /declares no value set — the reader is broken/);
  refused((i) => { i.required = ["1.1", "1.2", "1.9"]; }, /required value set 1\.9 is absent from the translation's sidecar/);
  refused((i) => { i.translation = index({ "1.1": set("a", "b"), "1.2": set() }); }, /required value set 1\.2 is empty/);
  refused((i) => { i.translation = index({ "1.1": { ...set("a", "b"), declaredTotal: 5 }, "1.2": set("c") }); }, /1\.1 is truncated: 2 of the 5 codes/);
  refused((i) => { terminologyOf(i).truncated = [{ oid: "1.1", have: 2, declaredTotal: 5 }]; }, /records truncated expansions \(1\.1\)/);
});

test("the terminology must come from the VSAC release pinned for the translation's year", () => {
  refused((i) => { completionOf(i).manifest = "http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2025-05-08"; }, /expanded at .*2025-05-08, but a 2027 translation is expanded at .*2026-05-14/);
  refused((i) => { i.manifest.effectivePeriod = { start: "2028-01-01", end: "2028-12-31" }; }, /no VSAC release is pinned for 2028/);
});

test("every declared set carries a 'release' completion whose counts are the two sidecars'", () => {
  refused((i) => { completionOf(i).valueSets = completionOf(i).valueSets.filter((e) => e.oid !== "1.2"); }, /1\.2 has no completion record/);
  refused((i) => { completionOf(i).valueSets[0]!.reason = "capped"; }, /completion of 1\.1 has reason 'capped', not 'release'/);
  refused((i) => { completionOf(i).valueSets[0]!.now = 3; }, /completion of 1\.1 records now=3, but the translation's sidecar holds 2/);
  refused((i) => { completionOf(i).valueSets[0]!.had = 1; }, /completion of 1\.1 records had=1, but CMS's sidecar holds 2/);
  // A set CMS's sidecar does not hold had nothing.
  refused((i) => { completionOf(i).valueSets[1]!.had = 1; }, /completion of 1\.2 records had=1, but CMS's sidecar holds 0/);
  refused((i) => { completionOf(i).valueSets[1]!.declaredTotal = 4; }, /completion of 1\.2 is truncated: 1 of the 4 codes/);
});

test("the sets whose codes differ from CMS's must be the pinned ones", () => {
  refused((i) => { i.expectedChanged = undefined; }, /no EXPECTED_CHANGED_SETS entry\. This build differs from CMS's sidecar by \{"oids":\["1\.1","1\.2","1\.3"\],"added":2,"removed":2\}/);
  refused((i) => { i.expectedChanged = { oids: ["1.2", "1.3"], added: 2, removed: 2 }; }, /code sets that differ from CMS's are/);
  refused((i) => { i.expectedChanged = { oids: ["1.1", "1.2", "1.3"], added: 3, removed: 2 }; }, /code sets that differ from CMS's are/);
  // A translation that kept CMS's codes for 1.1 no longer differs there, which the pin must notice.
  refused((i) => { i.translation = index({ "1.1": set("a", "x"), "1.2": set("c") }); }, /code sets that differ from CMS's are \{"oids":\["1\.2","1\.3"\]/);
});

test("every recorded check ran against the committed artifact and terminology", () => {
  refused((i) => { i.manifest.derived!.oracles[0]!.ranAgainst.artifactSha256 = "sha256:old"; }, /'cypress-deck' check ran against sha256:old/);
  refused((i) => { i.manifest.derived!.oracles[1]!.ranAgainst = { artifactSha256: ARTIFACT, terminologySha256: "sha256:old" }; }, /'terminology-equivalence' check ran against .* \/ sha256:old/);
  refused((i) => { i.manifest.derived!.oracles = []; }, /records no check at all/);
});

// ---- each committed translation, on the real sidecars -------------------------------------------------

/** A sidecar's text, or `null` when it has not been vendored here — any other read failure is a failure. */
function readSidecar(dir: string, id: string, artifact: OfficialArtifact): string | null {
  try {
    return readFileSync(join(dir, id, artifact.manifest.terminology?.file ?? "terminology.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

for (const id of discoverTranslations(DERIVED_DIR)) {
  test(`${id}: the translation's terminology is pinned, complete, from its year's release, and routes unstubbed`, (t) => {
    // Neither needs a sidecar, so neither may skip.
    const translation = loadDerivedArtifact(id);
    assert.ok(translation, `${id} must load as a translation (a catalog-id name, a manifest with a derived block, an executable bundle)`);
    const official = loadOfficialArtifact(id);
    assert.ok(official, `${id}: a translation is never committed without the CMS artifact it translates`);

    const own = readSidecar(DERIVED_DIR, id, translation);
    const cms = readSidecar(OFFICIAL_DIR, id, official);
    if (own === null || cms === null) {
      const where = own === null ? `measures/derived/${id}/` : `measures/official/${id}/`;
      const why = `${id}: the terminology sidecar in ${where} is fetched at build (node scripts/vendor-derived-terminology.mjs, pnpm vendor:official)`;
      // The official-cases CI job vendors both and sets the flag, so there a missing sidecar fails.
      if (process.env.WORKWELL_REQUIRE_OFFICIAL_TERMINOLOGY === "true") assert.fail(why);
      t.skip(why);
      return;
    }
    // CMS's sidecar must itself be the pinned one, or every `had` below is compared with the wrong codes.
    const cmsLoaded = loadOfficialTerminology(official);
    assert.ok(cmsLoaded.ok, cmsLoaded.ok ? "" : cmsLoaded.problem);

    const required = [...new Set(requiredOids(translation))];
    assert.deepEqual(
      terminologyProblems({
        id,
        manifest: translation.manifest,
        sidecarSha256: sha256(own),
        required,
        translation: indexSidecar(own),
        official: indexSidecar(cms),
        expectedChanged: EXPECTED_CHANGED_SETS[id],
      }),
      [],
    );
    // The runtime's own readers agree with the ones above.
    assert.deepEqual(absentValueSets(translation, required), [], `${id}: the runtime finds a declared set the sidecar does not hold`);
    assert.deepEqual(cappedExpansions(translation, required), [], `${id}: the runtime finds a capped expansion`);
    // And the router itself with NO stubs — the real loaders, both sidecars — is what a deploy constructs.
    assert.deepEqual(officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: id, WORKWELL_DERIVED_MEASURES: id }), []);
  });
}
