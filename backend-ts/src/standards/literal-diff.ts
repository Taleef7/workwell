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

/** The catalog id whose vendored artifact this diff executes. */
const OFFICIAL_CATALOG_ID = "cms122";

type FhirBundle = { resourceType: "Bundle"; type?: string; entry: Array<{ resource: Record<string, unknown> }> };

/** The vendored official artifact, or null when it is absent/unusable (→ the tier falls back). */
export function loadOfficialCms122Bundle(): FhirBundle | null {
  return (loadOfficialArtifact(OFFICIAL_CATALOG_ID)?.bundle as FhirBundle | undefined) ?? null;
}

/** True when the literal tier can be attempted (vendored artifact present + every library carries ELM). */
export function literalDiffAvailable(): boolean {
  return officialArtifactAvailable(OFFICIAL_CATALOG_ID);
}

/**
 * Harness-local QICore-structural stamping: the literal QICore measure's retrieves are stricter than
 * WorkWell's plain-FHIR cms122 — a diabetes Condition must be an ACTIVE, CONFIRMED problem whose prevalence
 * period overlaps the measurement period (QICoreCommon `ToInterval`/`isActive`), and Encounters expect a
 * `class`. Our synthetic Conditions carry a system-less `clinicalStatus` and no `onsetDateTime`, so without
 * this normalization the QICore "Has Diabetes" retrieve drops every subject and the whole population reads
 * out-of-population. This is additive/normalizing, in-place on the diff harness's OWN bundle copy — WorkWell's
 * cms122 CQL reads none of these fields, so its outcome is byte-identical (ADR-008 guard test). `asOf` (the
 * run's eval date) anchors the onset well before the measurement period.
 */
function stampQiCoreStructure(bundle: FhirBundle, asOf: string): void {
  const clinicalActive = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] };
  const verifConfirmed = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] };
  const problemCategory = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "problem-list-item" }] };
  const ambClass = { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" };
  const onset = `${Number(asOf.slice(0, 4)) - 3}-01-01`; // well before the [year-01-01, year-12-31] measurement period
  for (const e of bundle.entry) {
    const r = e.resource as Record<string, unknown>;
    if (r.resourceType === "Condition") {
      // Overwrite (not merge): the synthetic clinicalStatus coding is system-less and won't match the
      // QICore ConditionClinicalStatusCodes value; a fully-coded active/confirmed status is required.
      r.clinicalStatus = clinicalActive;
      r.verificationStatus = verifConfirmed;
      if (!r.category) r.category = [problemCategory];
      if (!r.onsetDateTime && !r.onsetPeriod) r.onsetDateTime = onset;
    } else if (r.resourceType === "Encounter") {
      if (!r.class) r.class = ambClass;
    }
  }
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

  const artifact = loadOfficialArtifact(OFFICIAL_CATALOG_ID);
  const bundle = deps.officialBundle ?? (artifact?.bundle as FhirBundle | undefined);
  if (!bundle) throw new Error("literal-diff: official CMS122 artifact unavailable");
  // Provenance for the report. An injected test bundle has no manifest, so fall back to the vendored
  // one's metadata when present, and to honest placeholders when it is not.
  const official = artifact?.manifest ?? {
    measureName: "CMS122FHIRDiabetesAssessGT9Pct",
    version: "unknown",
    url: "https://madie.cms.gov/Measure/CMS122FHIRDiabetesAssessGT9Pct",
  };

  // Pre-expand the official measure's value sets from the imported VSAC rows.
  const expansions: Expansions = new Map<string, CqlCode[]>();
  for (const oid of CMS122_OFFICIAL_META.valueSets ?? []) expansions.set(oid, await deps.resolver.expand(oid));
  const valueSetCache = await buildValueSetCache(bundle as MeasureBundle, (oid) => deps.resolver.expand(oid));

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
      stampQiCoreStructure(enriched, deps.asOf);
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
