/**
 * A WorkWell translation of CMS137 for tests, built from the COMMITTED official cms137 bundle by the same
 * identity rewrite a real translation goes through — so no CMS bytes beyond what is already vendored,
 * and no translation is ever written into `measures/derived/`. The CQL is CMS's unchanged (C3a adds the
 * 2027 edits); what this fixture exercises is everything AROUND the logic: selection by year, terminology
 * keyed by artifact, identity, the router's checks and the evidence a translation writes.
 */
import { libraryElmSha256, rewriteDerivedIdentity } from "../standards/derived-identity.ts";
import { loadOfficialArtifact, type OfficialArtifact, type OfficialManifest } from "../wiring/official-artifacts.ts";

export const FIXTURE_LABEL = "WorkWell translation of CMS137v15";
export const FIXTURE_URL = "urn:workwell:measure:cms137:translation";
export const FIXTURE_SHA = `sha256:${"e".repeat(64)}`;
export const FIXTURE_TERMINOLOGY_SHA = `sha256:${"d".repeat(64)}`;

interface BundleEntry {
  resource?: Record<string, unknown>;
}

export function derivedCms137(over: Partial<OfficialManifest> = {}): OfficialArtifact {
  const base = loadOfficialArtifact("cms137");
  if (!base) throw new Error("the committed cms137 artifact is missing");
  const bundle = rewriteDerivedIdentity(base.bundle as { entry?: BundleEntry[] }, {
    url: FIXTURE_URL,
    version: "ww-2027.1",
    name: "WorkWellCMS137Translation2027",
    title: FIXTURE_LABEL,
    derivedFrom: "CMS137v15",
    effectivePeriod: { start: "2027-01-01", end: "2027-12-31" },
  });
  const resources = (bundle.entry ?? []).map((e) => e.resource).filter((r): r is Record<string, unknown> => !!r);
  const measure = resources.find((r) => r["resourceType"] === "Measure")!;
  const mainUrl = (measure["library"] as string[])[0];
  const unchangedLibraries = resources
    .filter((r) => r["resourceType"] === "Library" && r["url"] !== mainUrl)
    .map((l) => ({ name: String(l["name"]), version: String(l["version"]), elmSha256: libraryElmSha256(l)! }));
  const manifest: OfficialManifest = {
    ...base.manifest,
    cmsId: null,
    url: FIXTURE_URL,
    version: "ww-2027.1",
    status: "draft",
    effectivePeriod: { start: "2027-01-01", end: "2027-12-31" },
    sha256: FIXTURE_SHA,
    terminology: {
      ...base.manifest.terminology!,
      sha256: FIXTURE_TERMINOLOGY_SHA,
      completion: { source: "vsac", manifest: "http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14", valueSets: [] },
    },
    derived: {
      label: FIXTURE_LABEL,
      derivedFrom: { ecqm: "CMS137v15", packageSha256: `sha256:${"a".repeat(64)}` },
      base: { catalogId: "cms137", manifestSha256: base.manifest.sha256 },
      build: { translator: "@cqframework/cql@4.0.0-beta.1", modelInfoSha256: "sha256:75cf34cc", signatureLevel: "All", translationSha256: `sha256:${"b".repeat(64)}` },
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
