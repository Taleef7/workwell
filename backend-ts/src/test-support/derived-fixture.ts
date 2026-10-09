/**
 * A WorkWell translation of CMS137 for tests, built from the COMMITTED official cms137 bundle by the same
 * identity rewrite a real translation goes through — so no CMS bytes beyond what is already vendored,
 * and no translation is ever written into `measures/derived/`. The CQL is CMS's unchanged (C3a adds the
 * 2027 edits); what this fixture exercises is everything AROUND the logic: selection by year, terminology
 * keyed by artifact, identity, the router's checks and the evidence a translation writes.
 *
 * Its manifest is shaped exactly as `build:derived` writes one — the name the Measure carries, no `tests`
 * block (CMS's deck belongs to CMS's artifact), the pinned model info and the installed translator — so
 * the router's identity check passes it for the same reasons it would pass a real translation.
 *
 * `derivedCms130Changed` is the second shape (#779): a translation that carries a CHANGED CMS shared
 * library under WorkWell's identity, built the same way from the committed official cms130 artifact.
 */
import { translationIdentity } from "../standards/derived-build.ts";
import { changedLibraryIdentity, rewriteChangedLibrary } from "../standards/derived-changed-library.ts";
import { installedTranslatorVersion, libraryElmSha256, QICORE_MODEL_INFO_SHA256, rewriteDerivedIdentity, translatorId } from "../standards/derived-identity.ts";
import { loadOfficialArtifact, type DerivedChangedLibrary, type OfficialArtifact, type OfficialManifest } from "../wiring/official-artifacts.ts";

const IDENTITY = translationIdentity("cms137", 2027, "CMS137v15");
export const FIXTURE_LABEL = IDENTITY.title;
export const FIXTURE_URL = IDENTITY.url;
export const FIXTURE_SHA = `sha256:${"e".repeat(64)}`;
export const FIXTURE_TERMINOLOGY_SHA = `sha256:${"d".repeat(64)}`;

interface BundleEntry {
  resource?: Record<string, unknown>;
}

export function derivedCms137(over: Partial<OfficialManifest> = {}): OfficialArtifact {
  const base = loadOfficialArtifact("cms137");
  if (!base) throw new Error("the committed cms137 artifact is missing");
  const bundle = rewriteDerivedIdentity(base.bundle as { entry?: BundleEntry[] }, IDENTITY);
  const resources = (bundle.entry ?? []).map((e) => e.resource).filter((r): r is Record<string, unknown> => !!r);
  const measure = resources.find((r) => r["resourceType"] === "Measure")!;
  const mainUrl = (measure["library"] as string[])[0];
  const unchangedLibraries = resources
    .filter((r) => r["resourceType"] === "Library" && r["url"] !== mainUrl)
    .map((l) => ({ name: String(l["name"]), version: String(l["version"]), elmSha256: libraryElmSha256(l)! }));
  // CMS's deck is pinned by CMS's manifest; a translation's manifest never carries it.
  const { tests: _cmsDeck, ...cmsManifest } = base.manifest;
  const manifest: OfficialManifest = {
    ...cmsManifest,
    measureName: IDENTITY.name,
    cmsId: null,
    url: IDENTITY.url,
    version: IDENTITY.version,
    status: "draft",
    effectivePeriod: IDENTITY.effectivePeriod,
    sha256: FIXTURE_SHA,
    terminology: {
      ...base.manifest.terminology!,
      sha256: FIXTURE_TERMINOLOGY_SHA,
      completion: { source: "vsac", manifest: "http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14", valueSets: [] },
    },
    derived: {
      label: FIXTURE_LABEL,
      derivedFrom: { ecqm: IDENTITY.derivedFrom, packageSha256: `sha256:${"a".repeat(64)}` },
      base: { catalogId: "cms137", manifestSha256: base.manifest.sha256 },
      build: {
        translator: translatorId(installedTranslatorVersion()),
        modelInfoSha256: `sha256:${QICORE_MODEL_INFO_SHA256}`,
        signatureLevel: "All",
        translationSha256: `sha256:${"b".repeat(64)}`,
      },
      unchangedLibraries,
      oracles: [
        { name: "cypress-deck", inputSha256: `sha256:${"c".repeat(64)}`, period: { start: "2025-01-01", end: "2025-12-31" }, agree: 36, total: 36, result: "pass", ranAgainst: { artifactSha256: FIXTURE_SHA, terminologySha256: FIXTURE_TERMINOLOGY_SHA } },
        { name: "terminology-equivalence", inputSha256: `sha256:${"f".repeat(64)}`, period: { start: "2027-01-01", end: "2027-12-31" }, agree: 28, total: 28, result: "pass", ranAgainst: { artifactSha256: FIXTURE_SHA, terminologySha256: FIXTURE_TERMINOLOGY_SHA } },
      ],
    },
    ...over,
  };
  return { kind: "derived", manifest, bundle: bundle as OfficialArtifact["bundle"] };
}

const CMS130_IDENTITY = translationIdentity("cms130", 2027, "CMS130v15");
/** The CMS shared library the CMS130 translation edits (#779), as CMS's committed artifact names it. */
export const CMS130_CHANGED_FROM = { name: "AdvancedIllnessandFrailty", version: "1.27.000" } as const;
export const CMS130_CHANGED = changedLibraryIdentity(CMS130_CHANGED_FROM.name, CMS130_CHANGED_FROM.version, CMS130_IDENTITY);
export const FIXTURE_CMS130_SHA = `sha256:${"1".repeat(64)}`;
export const FIXTURE_CMS130_TERMINOLOGY_SHA = `sha256:${"2".repeat(64)}`;

/**
 * A WorkWell translation of CMS130 with a CHANGED shared library, for tests: CMS's AdvancedIllnessandFrailty
 * carried under WorkWell's identity, and the main library's include and depends-on repointed at it — by the
 * same two rewrites the builder applies (`rewriteDerivedIdentity`, then `rewriteChangedLibrary`), over the
 * COMMITTED official cms130 artifact.
 *
 * The "compiled" ELM handed to `rewriteChangedLibrary` is CMS's own AdvancedIllnessandFrailty ELM: the
 * identity check reads names, includes, hashes and provenance, never logic, so it needs no real edit — and
 * no CMS CQL is compiled or committed for a test. Two consequences a reader should know: that ELM still
 * writes its own includes namespaced (`https://madie.cms.gov/FHIRHelpers`), as WorkWell's compile would
 * not, so the fixture also proves a namespaced include in a changed library resolves; and the main
 * library's ELM is CMS's too (its includes namespaced, but for the repointed one).
 *
 * Its manifest is shaped as `build:derived` writes one: `changedLibraries` after `unchangedLibraries`,
 * `from.elmSha256` the hash of CMS's committed ELM, the changed library absent from `unchangedLibraries`.
 */
export function derivedCms130Changed(over: Partial<OfficialManifest> = {}): OfficialArtifact {
  const base = loadOfficialArtifact("cms130");
  if (!base) throw new Error("the committed cms130 artifact is missing");
  const baseResources = ((base.bundle as { entry?: BundleEntry[] }).entry ?? []).map((e) => e.resource).filter((r): r is Record<string, unknown> => !!r);
  const cmsLibrary = baseResources.find((r) => r["resourceType"] === "Library" && r["name"] === CMS130_CHANGED_FROM.name && r["version"] === CMS130_CHANGED_FROM.version);
  if (!cmsLibrary) throw new Error(`the committed cms130 artifact holds no ${CMS130_CHANGED_FROM.name} ${CMS130_CHANGED_FROM.version}`);
  const cmsElmData = (cmsLibrary["content"] as Array<{ contentType?: string; data?: string }>).find((c) => c.contentType === "application/elm+json")!.data!;
  const compiled = JSON.parse(Buffer.from(cmsElmData, "base64").toString("utf8")) as Parameters<typeof rewriteChangedLibrary>[2];

  const renamed = rewriteDerivedIdentity(base.bundle as { entry?: BundleEntry[] }, CMS130_IDENTITY);
  const bundle = rewriteChangedLibrary(renamed, CMS130_CHANGED_FROM, compiled, CMS130_CHANGED);
  const resources = (bundle.entry ?? []).map((e) => e.resource).filter((r): r is Record<string, unknown> => !!r);
  const measure = resources.find((r) => r["resourceType"] === "Measure")!;
  const mainUrl = (measure["library"] as string[])[0];
  const unchangedLibraries = resources
    .filter((r) => r["resourceType"] === "Library" && r["url"] !== mainUrl && r["url"] !== CMS130_CHANGED.url)
    .map((l) => ({ name: String(l["name"]), version: String(l["version"]), elmSha256: libraryElmSha256(l)! }));
  const changedLibraries: DerivedChangedLibrary[] = [
    {
      name: CMS130_CHANGED.name,
      version: CMS130_CHANGED.version,
      from: { ...CMS130_CHANGED_FROM, elmSha256: libraryElmSha256(cmsLibrary)! },
      translationSha256: `sha256:${"9".repeat(64)}`,
    },
  ];
  const { tests: _cmsDeck, ...cmsManifest } = base.manifest;
  const manifest: OfficialManifest = {
    ...cmsManifest,
    measureName: CMS130_IDENTITY.name,
    cmsId: null,
    url: CMS130_IDENTITY.url,
    version: CMS130_IDENTITY.version,
    status: "draft",
    effectivePeriod: CMS130_IDENTITY.effectivePeriod,
    sha256: FIXTURE_CMS130_SHA,
    terminology: {
      ...base.manifest.terminology!,
      sha256: FIXTURE_CMS130_TERMINOLOGY_SHA,
      completion: { source: "vsac", manifest: "http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14", valueSets: [] },
    },
    derived: {
      label: CMS130_IDENTITY.title,
      derivedFrom: { ecqm: CMS130_IDENTITY.derivedFrom, packageSha256: `sha256:${"a".repeat(64)}` },
      base: { catalogId: "cms130", manifestSha256: base.manifest.sha256 },
      build: {
        translator: translatorId(installedTranslatorVersion()),
        modelInfoSha256: `sha256:${QICORE_MODEL_INFO_SHA256}`,
        signatureLevel: "All",
        // The main library's CQL, which for CMS130 is CMS's unedited text; the edit's own hash is the
        // changed library's `translationSha256`.
        translationSha256: `sha256:${"b".repeat(64)}`,
      },
      unchangedLibraries,
      changedLibraries,
      oracles: [
        { name: "cypress-deck", inputSha256: `sha256:${"c".repeat(64)}`, period: { start: "2027-01-01", end: "2027-12-31" }, agree: 269, total: 269, result: "pass", ranAgainst: { artifactSha256: FIXTURE_CMS130_SHA, terminologySha256: FIXTURE_CMS130_TERMINOLOGY_SHA } },
        { name: "terminology-equivalence", inputSha256: `sha256:${"f".repeat(64)}`, period: { start: "2027-01-01", end: "2027-12-31" }, agree: 31, total: 31, result: "pass", ranAgainst: { artifactSha256: FIXTURE_CMS130_SHA, terminologySha256: FIXTURE_CMS130_TERMINOLOGY_SHA } },
      ],
    },
    ...over,
  };
  return { kind: "derived", manifest, bundle: bundle as OfficialArtifact["bundle"] };
}
