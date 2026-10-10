/**
 * Per-measure data coverage (#776): what each routed measure's logic reads, and whether WebChart ingest
 * supplies it.
 *
 * "Reads" is computed from the committed artifact (`standards/measure-data-requirements.ts`), so a measure
 * that starts reading a new type shows up here without anyone remembering to list it. "Supplies" is the
 * one table the WebChart client fetches from (`engine/ingress/webchart/served-resources.ts`) plus the
 * profiles preparation stamps. It describes the WebChart live-tenant path only: the Maui sandbox's
 * synthetic corpus emits most of what is missing here, so sandbox rates are not what WebChart data would
 * give.
 *
 * A type a measure reads but ingest does not supply carries a reason, and `data-coverage.test.ts` fails
 * on one without a reason and on a reason no measure needs any more. "Supplied" means the resources reach
 * the bundle; whether the measure can COUNT them is the data's business (coding, status), not this
 * report's.
 */
import { WEBCHART_SERVED_RESOURCES } from "../engine/ingress/webchart/served-resources.ts";
import { ecqmIdOf } from "../measure/measure-identity.ts";
import { measureDataRequirements } from "../standards/measure-data-requirements.ts";
import { loadDerivedArtifact, loadOfficialArtifact, type OfficialArtifact } from "./official-artifacts.ts";
import { OFFICIAL_MEASURE_SEMANTICS } from "./official-measure-semantics.ts";
import { PROFILES_STAMPED_AT_PREPARATION } from "./qicore-preparation.ts";

/** Why ingest does not supply a type some routed measure reads. One entry per such type, no more. */
export const NOT_SERVED_REASONS: Readonly<Record<string, string>> = {
  Medication:
    "Read only where a MedicationRequest references a Medication. WebChart's trial names every drug inline instead (checked 2026-10-09) and declares no _include to fetch one.",
  DeviceRequest:
    "WebChart's FHIR CapabilityStatement does not list it (checked 2026-10-09); where device orders live is an open question to MIE.",
};

/** A type ingest fetches, read through a trusted profile ingest never stamps. */
export const UNSTAMPED_PROFILE_REASON =
  "This measure retrieves this type by a profile ingest does not stamp, and a resource without it is not retrieved. Running cms165 on WebChart data is #591.";

export interface CoverageRow {
  readonly type: string;
  readonly forScore: boolean;
  readonly forSde: boolean;
  /**
   * `served`: the resources reach the bundle in a form the measure retrieves. `partial`: a profile-sensitive
   * measure retrieves this type in several profiles and ingest stamps only some (`stampedProfiles`).
   */
  readonly status: "served" | "partial" | "not served";
  /** How ingest gets the type, or null when it does not. */
  readonly how: "population" | "fetched" | null;
  /** What ingest derives of this type from other resources, or empty. */
  readonly derived: string;
  /** What is known about WebChart's data for this type that limits what a measure can count, or empty. */
  readonly caveat: string;
  readonly profiles: readonly string[];
  /** For a profile-sensitive measure, the profiles it retrieves by that ingest stamps, and those it does not. */
  readonly stampedProfiles: readonly string[];
  readonly unstampedProfiles: readonly string[];
  /** Why it is not (fully) served; null when it is (or when nobody wrote one, which the test refuses). */
  readonly reason: string | null;
}

export interface MeasureCoverage {
  readonly measureId: string;
  readonly kind: "cms-artifact" | "workwell-translation";
  /** The logic this table is for, as the screens name it: `CMS165FHIR v1.0.000`, or a translation's label. */
  readonly logic: string;
  /** The profiles the executor retrieves by `meta.profile` for this measure (`trustedProfiles`, #591); empty when none. */
  readonly trustedProfiles: readonly string[];
  readonly rows: readonly CoverageRow[];
}

const SERVED = new Map(WEBCHART_SERVED_RESOURCES.map((resource) => [resource.type, resource]));
const STAMPED = new Set<string>(PROFILES_STAMPED_AT_PREPARATION);

/**
 * Whether a profile-filtered retrieve can match what ingest supplies, as `cql-exec-fhir` decides it
 * (`requireProfileTagging`, lib/fhir.js): a retrieve by the type's base StructureDefinition is exempt from
 * the filter; any other profile must be in `meta.profile`.
 */
const retrievable = (type: string, profile: string): boolean =>
  STAMPED.has(profile) || profile === `http://hl7.org/fhir/StructureDefinition/${type}`;

function logicOf(kind: MeasureCoverage["kind"], artifact: OfficialArtifact): string {
  const manifest = artifact.manifest as OfficialArtifact["manifest"] & { derived?: { label?: string } };
  if (kind === "workwell-translation") return `${manifest.derived?.label ?? manifest.catalogId} (${manifest.version})`;
  return `${manifest.cmsId ? ecqmIdOf(manifest.cmsId) : manifest.measureName} v${manifest.version}`;
}

/** One logic's coverage table. Pure over the artifact. */
export function coverageOf(
  measureId: string,
  kind: MeasureCoverage["kind"],
  artifact: OfficialArtifact,
  trustedProfiles: readonly string[] = OFFICIAL_MEASURE_SEMANTICS[measureId]?.trustedProfiles ?? [],
): MeasureCoverage {
  const rows = measureDataRequirements(artifact.bundle).map((requirement): CoverageRow => {
    const served = SERVED.get(requirement.type);
    // Only a trusted profile's retrieve is filtered on `meta.profile`; every other retrieve of the type,
    // with or without a profile, reads the resources by type.
    const filtered = served !== undefined ? requirement.profiles.filter((profile) => trustedProfiles.includes(profile)) : [];
    const stampedProfiles = filtered.filter((profile) => retrievable(requirement.type, profile));
    const unstampedProfiles = filtered.filter((profile) => !retrievable(requirement.type, profile));
    const status: CoverageRow["status"] =
      served === undefined ? "not served" : unstampedProfiles.length === 0 ? "served" : stampedProfiles.length > 0 ? "partial" : "not served";
    return {
      type: requirement.type,
      forScore: requirement.forScore,
      forSde: requirement.forSde,
      status,
      how: served?.how ?? null,
      derived: served?.derived ?? "",
      caveat: served?.caveat ?? "",
      profiles: requirement.profiles,
      stampedProfiles,
      unstampedProfiles,
      reason: status === "served" ? null : served ? UNSTAMPED_PROFILE_REASON : (NOT_SERVED_REASONS[requirement.type] ?? null),
    };
  });
  return { measureId, kind, logic: logicOf(kind, artifact), trustedProfiles, rows };
}

/**
 * Every logic each measure may be scored by: CMS's artifact, and the WorkWell translation where one is
 * committed. Throws for a measure with no committed CMS artifact, since there is nothing to read.
 */
export function dataCoverage(measureIds: readonly string[]): MeasureCoverage[] {
  return measureIds.flatMap((measureId) => {
    const official = loadOfficialArtifact(measureId);
    if (!official) throw new Error(`${measureId} has no committed CMS artifact under measures/official/`);
    const translation = loadDerivedArtifact(measureId);
    return [
      coverageOf(measureId, "cms-artifact", official),
      ...(translation ? [coverageOf(measureId, "workwell-translation", translation)] : []),
    ];
  });
}
