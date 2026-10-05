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
 */
import { translationIdentity } from "../standards/derived-build.ts";
import { installedTranslatorVersion, libraryElmSha256, QICORE_MODEL_INFO_SHA256, rewriteDerivedIdentity, translatorId } from "../standards/derived-identity.ts";
import { loadOfficialArtifact, type OfficialArtifact, type OfficialManifest } from "../wiring/official-artifacts.ts";

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
