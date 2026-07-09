/**
 * #258 — LITERAL official-CQL execution diff for CMS122 (the highest-fidelity tier).
 *
 * Runs the **literal, multi-library QICore CMS122v14 eCQM** — the exact official MADiE FHIR artifact
 * (`using QICore '6.0.0'`, 8 included libraries) — via MITRE's `fqm-execution` over the PRE-COMPILED ELM
 * pre-shipped in the vendored bundle's `Library.content` (`application/elm+json`). No translation happens
 * (which is what ADR-024 found intractable under the pinned JS translator); fqm-execution executes the
 * committed ELM on the same `cql-execution` + `cql-exec-fhir` runtime this repo already uses.
 *
 * DIAGNOSTIC-ONLY (ADR-026): `fqm-execution` is imported ONLY here, and this module is reached ONLY from
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
import { readFileSync } from "node:fs";

/** Provenance of the vendored official artifact (see measures/official/cms122v14/README.md). */
export const OFFICIAL_CMS122 = {
  name: "CMS122FHIRDiabetesAssessGreaterThan9Percent",
  version: "0.5.000",
  url: "https://madie.cms.gov/Measure/CMS122FHIRDiabetesAssessGreaterThan9Percent",
  bundleFile: "CMS122FHIR-v0.5.000-FHIR.json",
} as const;

const BUNDLE_URL = new URL(`../../measures/official/cms122v14/${OFFICIAL_CMS122.bundleFile}`, import.meta.url);

type FhirBundle = { resourceType: "Bundle"; type?: string; entry: Array<{ resource: Record<string, unknown> }> };

/** Parse + cache the vendored measure bundle once. Returns null if absent/corrupt (→ tier falls back). */
let bundleCache: FhirBundle | null | undefined;
export function loadOfficialCms122Bundle(): FhirBundle | null {
  if (bundleCache !== undefined) return bundleCache;
  try {
    const b = JSON.parse(readFileSync(BUNDLE_URL, "utf8")) as FhirBundle;
    const libs = b.entry.filter((e) => e.resource?.resourceType === "Library");
    const measure = b.entry.some((e) => e.resource?.resourceType === "Measure");
    const allElm = libs.length > 0 && libs.every((l) =>
      (l.resource.content as Array<{ contentType?: string; data?: string }> | undefined)?.some(
        (c) => c.contentType === "application/elm+json" && !!c.data,
      ),
    );
    bundleCache = measure && allElm ? b : null;
  } catch {
    bundleCache = null;
  }
  return bundleCache;
}

/** True when the literal tier can be attempted (vendored bundle present + every library carries ELM). */
export function literalDiffAvailable(): boolean {
  return loadOfficialCms122Bundle() !== null;
}

/** Distinct VSAC value-set canonicals the measure's ELM retrieves reference (across all libraries). */
function referencedValueSets(bundle: FhirBundle): string[] {
  const urls = new Set<string>();
  for (const e of bundle.entry) {
    const r = e.resource as { resourceType?: string; content?: Array<{ contentType?: string; data?: string }> };
    if (r.resourceType !== "Library") continue;
    const data = r.content?.find((c) => c.contentType === "application/elm+json")?.data;
    if (!data) continue;
    const elm = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as {
      library?: { valueSets?: { def?: Array<{ id: string }> } };
    };
    for (const d of elm.library?.valueSets?.def ?? []) urls.add(d.id);
  }
  return [...urls];
}

/**
 * Build a fqm-execution `valueSetCache`: one ValueSet per referenced canonical, expanded from the imported
 * VSAC rows via the resolver. Non-resolving sets are emitted EMPTY-but-PRESENT so fqm-execution never
 * errors on a missing value set (their retrieves simply return nothing — conservative). URL form is
 * `http://cts.nlm.nih.gov/fhir/ValueSet/<oid>`; the resolver is keyed by the bare OID.
 */
async function buildValueSetCache(bundle: FhirBundle, resolver: ValueSetResolver): Promise<unknown[]> {
  const urls = referencedValueSets(bundle);
  const cache: unknown[] = [];
  for (const url of urls) {
    const oid = url.includes("/ValueSet/") ? url.slice(url.lastIndexOf("/ValueSet/") + "/ValueSet/".length) : url;
    let codes: CqlCode[] = [];
    try {
      codes = await resolver.expand(oid);
    } catch {
      codes = [];
    }
    cache.push({
      resourceType: "ValueSet",
      id: oid,
      url,
      status: "active",
      expansion: {
        timestamp: "2026-01-01T00:00:00Z",
        contains: codes.map((c) => ({ system: c.system, code: c.code })),
      },
    });
  }
  return cache;
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

type PopulationResult = { populationType: string; result: boolean };
type FqmResult = { results?: Array<{ patientId?: string; detailedResults?: Array<{ populationResults?: PopulationResult[] }> }> };
type FqmCalculate = (measureBundle: unknown, patientBundles: unknown[], options: unknown, valueSetCache?: unknown[]) => Promise<FqmResult>;

const DISCLAIMER =
  "LITERAL execution diff: the official multi-library QICore CMS122v14 artifact (MADiE FHIR export), " +
  "executed from its PRE-COMPILED ELM via fqm-execution (no translation), per subject against WorkWell's " +
  "authored measure. fqm-execution is a diagnostic-only dependency (ADR-026). Descriptive only — CQL " +
  "Outcome Status remains the sole compliance authority (ADR-008).";

/** Map the official measure's population membership to WorkWell's outcome vocabulary. */
function officialOutcome(pr: PopulationResult[]): string {
  const g = (t: string) => pr.find((p) => p.populationType === t)?.result === true;
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

  const bundle = deps.officialBundle ?? loadOfficialCms122Bundle();
  if (!bundle) throw new Error("literal-diff: official CMS122 bundle unavailable");

  const calculate: FqmCalculate =
    deps.calculate ?? (await import("fqm-execution")).Calculator.calculate as unknown as FqmCalculate;

  // Pre-expand the official measure's value sets from the imported VSAC rows.
  const expansions: Expansions = new Map<string, CqlCode[]>();
  for (const oid of CMS122_OFFICIAL_META.valueSets ?? []) expansions.set(oid, await deps.resolver.expand(oid));
  const valueSetCache = await buildValueSetCache(bundle, deps.resolver);

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
      // still push a minimal bundle so the id stays alignable; but mark as errored → ERROR row below
    }
  }

  // Execute the literal official measure over ALL patient bundles in one fqm-execution pass (ELM cached).
  const officialBySubject = new Map<string, string>();
  try {
    const out = await calculate(
      bundle,
      patientBundles,
      {
        measurementPeriodStart: `${deps.asOf.slice(0, 4)}-01-01`,
        measurementPeriodEnd: `${deps.asOf.slice(0, 4)}-12-31`,
        calculateSDEs: false,
        disableHTMLGeneration: true,
        trustMetaProfile: false, // our bundles are plain FHIR (retrieve by base type, ignore profiles)
        verboseCalculationResults: true,
      },
      valueSetCache,
    );
    for (const er of out.results ?? []) {
      const pr = er.detailedResults?.[0]?.populationResults;
      if (er.patientId && pr) officialBySubject.set(er.patientId, officialOutcome(pr));
    }
  } catch (err) {
    // A batch-level fqm failure aborts the literal tier; the route degrades to the subset path.
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
      `Executed the LITERAL official ${ref.ecqmId} (${OFFICIAL_CMS122.name} v${OFFICIAL_CMS122.version}, ` +
      `pre-compiled ELM via fqm-execution) against ${subjects.length} subjects of the latest ${ref.measureId} ` +
      `run: ${totalDivergent} diverge from the official age/visit/exclusion/numerator criteria` +
      (totalErrors > 0 ? `; ${totalErrors} could not be evaluated (excluded from the divergence count).` : "."),
    disclaimer: DISCLAIMER,
    officialMeasure: { name: OFFICIAL_CMS122.name, version: OFFICIAL_CMS122.version, url: OFFICIAL_CMS122.url },
  };
  if (runId) {
    if (cache.size >= 16) cache.clear();
    cache.set(runId, report);
  }
  return report;
}
