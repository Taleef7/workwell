/**
 * #258 — LITERAL official-CQL execution diff for CMS122 (the highest-fidelity tier).
 *
 * Runs the **literal, multi-library QICore CMS122v14 eCQM** — the exact official MADiE FHIR artifact
 * (`using QICore '6.0.0'`, 8 included libraries) — via MITRE's `fqm-execution` over the PRE-COMPILED ELM
 * pre-shipped in the vendored bundle's `Library.content` (`application/elm+json`). No translation happens
 * (which is what ADR-024 found intractable under the pinned JS translator); fqm-execution executes the
 * committed ELM on the same `cql-execution` + `cql-exec-fhir` runtime this repo already uses.
 *
 * The fqm machinery now lives in `@workwell/official-executor` (extraction PR-4): the PACKAGE BOUNDARY is
 * the ADR-026 quarantine — `fqm-execution` appears in exactly one package.json, and that package's entry
 * imports it only through a lazy `await import`. This module keeps what is WorkWell-specific: reading the
 * vendored bundle off disk, harness-local enrichment, and the diff itself. It is still reached ONLY from
 * the `/api/measures/cms122/fidelity/diff` route — never the run pipeline, engine ingress, or worker.ts.
 * Descriptive only (ADR-008): it writes nothing and never sets an `Outcome Status`. The bundle enrichment
 * is harness-local (a copy fed to the diff harness), so WorkWell's cms122 outcomes stay byte-identical.
 */
import type { OfficialMeasureReference } from "./reference-types.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { ValueSetResolver, CqlCode } from "../engine/cql/value-set-resolver.ts";
import { CMS122_OFFICIAL_META, enrichForOfficialCms122, type Expansions } from "./cms122-official.ts";
import type { DiffEngine, SubjectDiff } from "./execution-diff.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { seededTargetFor } from "../run/distribution.ts";
import {
  buildValueSetCache,
  calculateOfficial,
  type FqmCalculate,
  type MeasureBundle,
  type PopulationMembership,
} from "@workwell/official-executor";
import { loadOfficialArtifact, officialArtifactAvailable } from "../wiring/official-artifacts.ts";
import { loadOfficialTerminology, officialTerminologyExpander } from "../wiring/official-terminology.ts";
import { expandArtifactTerminology } from "../wiring/official-executor-adapter.ts";
import { prepareForQiCore, type PreparableBundle } from "../wiring/qicore-preparation.ts";

/** The catalog id whose vendored artifact this diff executes. */
const OFFICIAL_CATALOG_ID = "cms122";

type FhirBundle = { resourceType: "Bundle"; type?: string; entry: Array<{ resource: Record<string, unknown> }> };

/** The vendored official artifact, or null when it is absent/unusable (→ the tier falls back). */
export function loadOfficialCms122Bundle(): FhirBundle | null {
  return (loadOfficialArtifact(OFFICIAL_CATALOG_ID)?.bundle as FhirBundle | undefined) ?? null;
}

/**
 * True when the literal tier can be attempted: the vendored artifact is present with ELM in every
 * library, AND its terminology sidecar is present and matches its pin.
 *
 * Terminology is part of availability since ADR-036 — the artifact alone cannot execute, and the sidecar
 * is fetched at build rather than committed, so "the build step has not run" is a normal state on a
 * fresh clone. Reporting it here is what makes the route degrade to the subset tier instead of
 * attempting a literal run that can only fail.
 */
export function literalDiffAvailable(): boolean {
  if (!officialArtifactAvailable(OFFICIAL_CATALOG_ID)) return false;
  const artifact = loadOfficialArtifact(OFFICIAL_CATALOG_ID);
  return !!artifact && loadOfficialTerminology(artifact).ok;
}

export interface LiteralDiffReport {
  mode: "literal";
  measureId: string;
  ecqmId: string;
  runId: string | null;
  asOf: string | null;
  totalSubjectsEvaluated: number;
  totalDivergent: number;
  /** Subjects whose WorkWell or literal evaluation could not be mapped — recorded, never counted divergent. */
  totalErrors: number;
  byGate: Record<string, number>;
  subjects: SubjectDiff[];
  headline: string;
  disclaimer: string;
  /** Provenance of the executed official artifact (additive; frontend ignores). */
  officialMeasure: { name: string; version: string; url: string };
}

export interface LiteralDiffDeps {
  engine: DiffEngine;
  resolver: ValueSetResolver;
  employees: readonly EmployeeProfile[];
  today: string;
  asOf: string;
  /** Injectable fqm-execution `Calculator.calculate` seam (real one loaded lazily by default). */
  calculate?: FqmCalculate;
  /** Injectable bundle (tests); defaults to the vendored artifact. */
  officialBundle?: FhirBundle;
  /**
   * Injectable terminology (tests); defaults to the artifact's own vendored sidecar.
   *
   * Injectable rather than falling back to the VSAC resolver, so the offline suite stays hermetic
   * WITHOUT production ever having a second terminology source to silently reach for.
   */
  valueSetCache?: unknown[];
}

const DISCLAIMER =
  "LITERAL execution diff: the official multi-library QICore CMS122v14 artifact (MADiE FHIR export), " +
  "executed from its PRE-COMPILED ELM via fqm-execution (no translation), per subject against WorkWell's " +
  "authored measure. fqm-execution is quarantined behind the @workwell/official-executor package " +
  "boundary and lazily imported (ADR-026 as amended). Descriptive only — CQL " +
  "Outcome Status remains the sole compliance authority (ADR-008).";

/**
 * Map the official measure's population membership onto WorkWell's outcome vocabulary. This mapping is
 * WorkWell policy, not measure execution, which is why it stays in the app rather than the package.
 */
function officialOutcome(membership: PopulationMembership): string {
  const g = (t: string) => membership[t] === true;
  if (!g("initial-population")) return "OUT_OF_POPULATION";
  if (g("denominator-exclusion")) return "EXCLUDED";
  if (!g("denominator")) return "OUT_OF_POPULATION";
  return g("numerator") ? "OVERDUE" : "COMPLIANT";
}

/** Which official gate accounts for a divergence (population-level; the finer per-define attribution
 * lives in the subset path). Derivable from population membership + WorkWell's outcome. */
function attributeGate(officialOut: string, workwellOut: string): string {
  if (officialOut === "OUT_OF_POPULATION") return "initial-population"; // age 18-75 / qualifying visit / diabetes — gates WorkWell omits
  if (officialOut === "EXCLUDED" && workwellOut !== "EXCLUDED") return "denominator-exclusion"; // hospice / palliative / frailty / LTC
  if (workwellOut === "EXCLUDED" && officialOut !== "EXCLUDED") return "workwell-exclusion"; // a urn:workwell waiver the official doesn't model
  if (officialOut === "OVERDUE" || officialOut === "COMPLIANT") return "numerator-glycemic-status"; // HbA1c / GMI numerator
  return "workwell-side";
}

// Keyed on runId (only the latest run is queried; terminal runs are immutable). Mirrors execution-diff.
const cache = new Map<string, LiteralDiffReport>();
/** @internal test hook */
export function __clearLiteralDiffCache(): void {
  cache.clear();
}

type Row = { subjectId: string; status: string; runId: string; runStartedAt: string };

export async function computeLiteralDiff(
  ref: OfficialMeasureReference,
  rows: Row[],
  deps: LiteralDiffDeps,
): Promise<LiteralDiffReport> {
  const runId = rows[0]?.runId ?? null;
  if (runId && cache.has(runId)) return cache.get(runId)!;

  const bundle = deps.officialBundle ?? (loadOfficialArtifact(OFFICIAL_CATALOG_ID)?.bundle as FhirBundle | undefined);
  if (!bundle) throw new Error("literal-diff: official CMS122 artifact unavailable");
  // Provenance is read from the Measure resource in the bundle we are ACTUALLY executing, not from the
  // vendored manifest. When a caller injects a different bundle, the report must describe that bundle -
  // attributing the run to the vendored artifact's name and version would be a provenance misstatement
  // in a report whose whole purpose is provenance.
  const measureResource = bundle.entry.find((e) => e.resource?.["resourceType"] === "Measure")?.resource as
    | { name?: string; version?: string; url?: string }
    | undefined;
  const official = {
    measureName: measureResource?.name ?? "unknown",
    version: measureResource?.version ?? "unknown",
    url: measureResource?.url ?? "unknown",
  };

  // Terminology comes from the ARTIFACT'S OWN vendored sidecar (ADR-036), never from our VSAC import.
  //
  // This is what makes the shadow period predictive. The whole purpose of running this diff before a
  // flip is to learn what the flip will do; if the diff expands one terminology and the runtime expands
  // another, it forecasts a configuration that will never exist. Before PR-8a the two genuinely
  // differed — the runtime read VSAC store rows while the MADiE gate read the upstream bundle — and
  // this call site was the last place still on the old source.
  //
  // The store resolver is still used for the SUBSET tier and for WorkWell's own authored evaluation
  // below, which is correct: those are urn:workwell measures and VSAC is their terminology.
  // No silent fallback to the VSAC resolver when the sidecar is absent: that is precisely the two-
  // authority split ADR-036 closed, and a diagnostic that quietly swaps terminology is worse than one
  // that is unavailable. `literalDiffAvailable()` already reports the sidecar as part of availability,
  // so the route declines the literal tier and degrades to subset VISIBLY, in its `mode` field.
  const artifact = loadOfficialArtifact(OFFICIAL_CATALOG_ID);
  // Explicit, not a `!`. The route only reaches here when `literalDiffAvailable()` is true, but this
  // function also accepts an INJECTED `officialBundle`, and on that path nothing guarantees a vendored
  // artifact exists — a non-null assertion would have turned that into a TypeError from inside fqm.
  if (!deps.valueSetCache && !artifact) {
    throw new Error(
      `${OFFICIAL_CATALOG_ID}: no vendored official artifact, so its terminology cannot be loaded — ` +
        `pass deps.valueSetCache to run the literal diff against an injected bundle`,
    );
  }
  const valueSetCache =
    deps.valueSetCache ??
    (await expandArtifactTerminology(artifact!, officialTerminologyExpander(loadOfficialArtifact)));

  // The harness-local enrichment reads the SAME cache that executes, so the two cannot drift.
  //
  // No per-OID fallback to the VSAC resolver. It would be dead code today (every
  // `CMS122_OFFICIAL_META` OID is in the sidecar) and a trap tomorrow: that list is hand-kept against
  // the artifact's 26 ELM canonicals, so the first re-vendor that adds one would silently start
  // enriching from a different terminology than the one being executed — the exact split ADR-036
  // closed, reintroduced one OID at a time. An OID the cache lacks enriches with nothing, and the
  // divergence shows up in the diff where it can be seen.
  const cachedValueSets = valueSetCache as Array<{
    id?: string;
    url?: string;
    expansion?: { contains?: CqlCode[] };
  }>;
  const expansions: Expansions = new Map<string, CqlCode[]>();
  for (const oid of CMS122_OFFICIAL_META.valueSets ?? []) {
    const expanded = cachedValueSets.find((vs) => vs.id === oid || String(vs.url ?? "").endsWith(`/${oid}`));
    expansions.set(oid, expanded?.expansion?.contains ?? []);
  }

  const binding = MEASURE_BINDINGS["cms122"]!;

  // Build one enriched patient bundle per subject + evaluate WorkWell's authored cms122 per subject.
  const patientBundles: FhirBundle[] = [];
  const workwellBySubject = new Map<string, string>();
  const errored = new Set<string>();
  const orderedSubjects: string[] = [];

  for (const row of rows) {
    const employee = deps.employees.find((e) => e.externalId === row.subjectId);
    if (!employee) continue;
    orderedSubjects.push(row.subjectId);
    try {
      const target = seededTargetFor(deps.employees, binding.rateKey, row.subjectId) ?? "MISSING_DATA";
      const config = deriveExamConfig(binding, target);
      const base = buildSyntheticBundle(employee, config, deps.today) as unknown as FhirBundle;
      const enriched = enrichForOfficialCms122(base as never, employee, expansions, deps.today) as unknown as FhirBundle;
      prepareForQiCore(enriched as PreparableBundle);
      patientBundles.push(enriched);
      const workwell = await deps.engine.evaluate({ measureId: "cms122", patientBundle: enriched, evaluationDate: deps.asOf });
      workwellBySubject.set(row.subjectId, workwell.outcome);
    } catch {
      errored.add(row.subjectId);
      // No bundle is pushed for this subject: results are aligned by patientId, not by position, and the
      // ERROR row below is emitted from `errored`.
    }
  }

  // Execute the literal official measure over ALL patient bundles in one pass (the ELM is parsed once).
  const officialBySubject = new Map<string, string>();
  try {
    const membershipBySubject = await calculateOfficial({
      bundle: bundle as MeasureBundle,
      patientBundles,
      period: { start: `${deps.asOf.slice(0, 4)}-01-01`, end: `${deps.asOf.slice(0, 4)}-12-31` },
      valueSetCache,
      calculate: deps.calculate,
    });
    for (const [subjectId, membership] of membershipBySubject) {
      officialBySubject.set(subjectId, officialOutcome(membership));
    }
  } catch (err) {
    // A batch-level failure aborts the literal tier; the route degrades to the subset path.
    throw new Error(`literal-diff: fqm-execution failed — ${err instanceof Error ? err.message : String(err)}`);
  }

  const subjects: SubjectDiff[] = [];
  const byGate: Record<string, number> = {};
  for (const subjectId of orderedSubjects) {
    if (errored.has(subjectId)) {
      subjects.push({ subjectId, workwellOutcome: "ERROR", officialOutcome: "ERROR", diverged: false, divergenceGate: "" });
      continue;
    }
    const workwellOut = workwellBySubject.get(subjectId) ?? "ERROR";
    const officialOut = officialBySubject.get(subjectId) ?? "ERROR";
    if (workwellOut === "ERROR" || officialOut === "ERROR") {
      subjects.push({ subjectId, workwellOutcome: workwellOut, officialOutcome: officialOut, diverged: false, divergenceGate: "" });
      continue;
    }
    const diverged = officialOut !== workwellOut;
    const gate = diverged ? attributeGate(officialOut, workwellOut) : "";
    if (diverged) byGate[gate] = (byGate[gate] ?? 0) + 1;
    subjects.push({ subjectId, workwellOutcome: workwellOut, officialOutcome: officialOut, diverged, divergenceGate: gate });
  }

  const totalErrors = subjects.filter((s) => s.officialOutcome === "ERROR").length;
  const totalDivergent = subjects.filter((s) => s.diverged).length;
  const report: LiteralDiffReport = {
    mode: "literal",
    measureId: ref.measureId,
    ecqmId: ref.ecqmId,
    runId,
    asOf: deps.asOf,
    totalSubjectsEvaluated: subjects.length,
    totalDivergent,
    totalErrors,
    byGate,
    subjects,
    headline:
      `Executed the LITERAL official ${ref.ecqmId} (${official.measureName} v${official.version}, ` +
      `pre-compiled ELM via fqm-execution) against ${subjects.length} subjects of the latest ${ref.measureId} ` +
      `run: ${totalDivergent} diverge from the official age/visit/exclusion/numerator criteria` +
      (totalErrors > 0 ? `; ${totalErrors} could not be evaluated (excluded from the divergence count).` : "."),
    disclaimer: DISCLAIMER,
    officialMeasure: { name: official.measureName, version: official.version, url: official.url },
  };
  if (runId) {
    if (cache.size >= 16) cache.clear();
    cache.set(runId, report);
  }
  return report;
}
