/**
 * #258 — the LITERAL official-CQL execution diff (the highest-fidelity tier), for ANY vendored measure.
 *
 * Runs the **literal, multi-library QICore eCQM** — the exact official MADiE FHIR artifact
 * (`using QICore '6.0.0'`) — via MITRE's `fqm-execution` over the PRE-COMPILED ELM pre-shipped in the
 * vendored bundle's `Library.content` (`application/elm+json`). No translation happens (which is what
 * ADR-024 found intractable under the pinned JS translator); fqm-execution executes the committed ELM on
 * the same `cql-execution` + `cql-exec-fhir` runtime this repo already uses.
 *
 * The fqm machinery lives in `@work-well/official-executor` (extraction PR-4): the PACKAGE BOUNDARY is
 * the ADR-026 quarantine — `fqm-execution` appears in exactly one package.json, and that package's entry
 * imports it only through a lazy `await import`. This module keeps what is WorkWell-specific: reading the
 * vendored bundle off disk and the diff itself. Reached ONLY from the `/api/measures/:id/fidelity/diff`
 * route — never the run pipeline, engine ingress, or worker.ts. Descriptive only (ADR-008): it writes
 * nothing and never sets an `Outcome Status`.
 *
 * ## PR-8d — this became a SHADOW of the runtime rather than a study of its own
 *
 * The diff exists to answer one question: what will the PR-9 flip do? It can only answer that if it
 * evaluates what the runtime would evaluate. Three things it did differently, all now aligned:
 *
 * 1. **The measurement period.** It used the calendar year while the executor used the registry's
 *    rolling 12 months — barely half the same days. Both now call `officialMeasurementPeriod`.
 * 2. **The bundle.** It fed the official artifact a harness-ENRICHED bundle: real VSAC codings appended,
 *    plus deliberate age-out / missing-visit / hospice / GMI injection so the ladder had divergences to
 *    attribute. That was necessary when the corpus could not reach the official populations at all, and
 *    became actively misleading once PR-8c fixed it (ADR-038) — a shadow period that manufactures
 *    divergence forecasts divergence that will not happen. Removed; the diff now runs the plain
 *    synthetic bundle, prepared exactly as the runtime prepares it.
 * 3. **Preparation in place.** It mutated the bundle and then evaluated WorkWell on the mutated copy.
 *    The runtime prepares a COPY so the authored engine sees the original; so does this now.
 *
 * The subset tier (`execution-diff.ts`) keeps the enrichment, which is correct — it is the fidelity
 * LAB, comparing authored cms122 against a hand-authored official-subset CQL, and manufactured
 * divergence is the point there.
 */
import type { OfficialMeasureReference } from "./reference-types.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { ValueSetResolver } from "@work-well/measure-engine";

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
} from "@work-well/official-executor";
import { loadOfficialArtifact, officialArtifactAvailable } from "../wiring/official-artifacts.ts";
import { loadOfficialTerminology, officialTerminologyExpander } from "../wiring/official-terminology.ts";
import {
  expandArtifactTerminology,
  officialMeasurementPeriod,
  outcomeFromPopulations,
} from "../wiring/official-executor-adapter.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { preparedForQiCore, type PreparableBundle } from "../wiring/qicore-preparation.ts";

type FhirBundle = { resourceType: "Bundle"; type?: string; entry: Array<{ resource: Record<string, unknown> }> };

/** The vendored official artifact for a measure, or null when absent/unusable (→ the tier falls back). */
export function loadOfficialMeasureBundle(measureId: string): FhirBundle | null {
  return (loadOfficialArtifact(measureId)?.bundle as FhirBundle | undefined) ?? null;
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
export function literalDiffAvailable(measureId: string): boolean {
  if (!officialArtifactAvailable(measureId)) return false;
  // Semantics gate availability for the same reason they gate ROUTING: without a recorded reading of
  // what the numerator means, the mapping below would guess, and guessing inverts an inverse measure.
  if (!officialMeasureSemantics(measureId)) return false;
  const artifact = loadOfficialArtifact(measureId);
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

const disclaimerFor = (ecqmId: string): string =>
  `LITERAL execution diff: the official multi-library QICore ${ecqmId} artifact (MADiE FHIR export), ` +
  "executed from its PRE-COMPILED ELM via fqm-execution (no translation), per subject against WorkWell's " +
  "authored measure, over the SAME measurement period and the SAME prepared bundle the official " +
  "executor would use at runtime — so this matches what a routed measure actually runs " +
  "that will never exist. fqm-execution is quarantined behind the @work-well/official-executor package " +
  "boundary and lazily imported (ADR-026 as amended). Descriptive only — CQL " +
  "Outcome Status remains the sole compliance authority (ADR-008)."

/**
 * Map official population membership onto WorkWell's outcome vocabulary — through the RUNTIME's own
 * function, which is the fourth and last thing PR-8d aligned.
 *
 * This file had its own copy, and the two disagreed on the branch that matters most. Out of the initial
 * population, the diff said `OUT_OF_POPULATION` while the runtime says `MISSING_DATA` — and both
 * authored measures also say `MISSING_DATA` for not-in-IPP. So a subject the two engines fully AGREE
 * about was scored as a divergence, attributed to the `initial-population` gate, and counted in a
 * headline claiming it diverges from the official criteria. After the flip that subject's stored status
 * would be unchanged. That is a manufactured divergence of exactly the kind removing the enrichment was
 * meant to stop, arriving through a different door.
 *
 * Latent on today's corpus (measured: 0 out-of-population subjects across all 100 employees for both
 * measures) and NOT latent for the six measures still to be onboarded, nor for live WebChart data —
 * where out-of-population is the normal state.
 *
 * The old local copy also hardcoded `numerator ? OVERDUE : COMPLIANT`, which is cms122's inverse
 * reading; the shared function takes `numeratorMeansCompliant` from the fail-closed semantics table.
 */
function officialOutcome(membership: PopulationMembership, numeratorMeansCompliant: boolean): string {
  return outcomeFromPopulations(membership, numeratorMeansCompliant).outcome;
}

/** Which official gate accounts for a divergence (population-level; the finer per-define attribution
 * lives in the subset path). Derivable from population membership + WorkWell's outcome. */
function attributeGate(officialOut: string, workwellOut: string): string {
  // Population-level and measure-NEUTRAL. The names used to be cms122's clinical gates
  // ("numerator-glycemic-status"), which would have labelled a cms125 mammography divergence as a
  // glycemic one. The finer per-define attribution lives in the subset path.
  if (officialOut === "MISSING_DATA") return "initial-population"; // age / qualifying visit / diagnosis gates WorkWell omits
  if (officialOut === "EXCLUDED" && workwellOut !== "EXCLUDED") return "denominator-exclusion"; // hospice / palliative / frailty / LTC
  if (workwellOut === "EXCLUDED" && officialOut !== "EXCLUDED") return "workwell-exclusion"; // a urn:workwell waiver the official doesn't model
  if (officialOut === "OVERDUE" || officialOut === "COMPLIANT") return "numerator";
  return "workwell-side";
}

/**
 * Memo of terminal runs' reports, keyed on **measure AND run**.
 *
 * runId alone was safe only while this tier was cms122-only, and PR-8d opening it to any vendored
 * measure made it a correctness bug: an `ALL_PROGRAMS` run writes every measure's outcomes under ONE
 * `runs.id`, so `latestRunRows` hands both measures the same run id. Asking for cms122's diff and then
 * cms125's returned the *identical object* — cms122's measureId, ecqmId, subjects, headline and
 * provenance, under cms125's URL. Precisely the "one measure's criteria reported under another
 * measure's name" this PR closed at the route, re-opened one layer down.
 */
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
  const cacheKey = runId ? `${ref.measureId}|${runId}` : null;
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey)!;

  const catalogId = ref.measureId;
  const semantics = officialMeasureSemantics(catalogId);
  if (!semantics) {
    throw new Error(
      `literal-diff: no recorded official semantics for '${catalogId}' — refusing to guess whether its ` +
        `numerator means compliant (see wiring/official-measure-semantics.ts)`,
    );
  }
  const bundle = deps.officialBundle ?? (loadOfficialArtifact(catalogId)?.bundle as FhirBundle | undefined);
  if (!bundle) throw new Error(`literal-diff: official ${catalogId} artifact unavailable`);
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
  const artifact = loadOfficialArtifact(catalogId);
  // Explicit, not a `!`. The route only reaches here when `literalDiffAvailable()` is true, but this
  // function also accepts an INJECTED `officialBundle`, and on that path nothing guarantees a vendored
  // artifact exists — a non-null assertion would have turned that into a TypeError from inside fqm.
  if (!deps.valueSetCache && !artifact) {
    throw new Error(
      `${catalogId}: no vendored official artifact, so its terminology cannot be loaded — ` +
        `pass deps.valueSetCache to run the literal diff against an injected bundle`,
    );
  }
  const valueSetCache =
    deps.valueSetCache ??
    (await expandArtifactTerminology(artifact!, officialTerminologyExpander(loadOfficialArtifact)));

  const binding = MEASURE_BINDINGS[catalogId];
  if (!binding) throw new Error(`literal-diff: no synthetic binding for '${catalogId}'`);

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
      // Exactly the runtime's split: the official artifact gets a PREPARED COPY, the authored engine
      // gets the bundle untouched. The diff used to prepare in place and then evaluate WorkWell on the
      // mutated bundle — so it reported WorkWell's outcome on data WorkWell will never see at runtime.
      // Harmless today (no authored CQL reads a Condition's status), but the whole claim of this file is
      // that it forecasts the flip, and "harmless as far as I can tell" is not that.
      patientBundles.push(preparedForQiCore(base as PreparableBundle) as unknown as FhirBundle);
      const workwell = await deps.engine.evaluate({
        measureId: catalogId,
        patientBundle: base,
        evaluationDate: deps.asOf,
      });
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
      // The RUNTIME's period, via the shared helper. This used to be the calendar year while the
      // executor used the registry's rolling window, so the two engines were compared over periods
      // sharing barely half their days and any resulting difference read as a logic divergence.
      period: officialMeasurementPeriod(catalogId, deps.asOf),
      valueSetCache,
      calculate: deps.calculate,
    });
    for (const [subjectId, membership] of membershipBySubject) {
      officialBySubject.set(subjectId, officialOutcome(membership, semantics.numeratorMeansCompliant));
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
    disclaimer: disclaimerFor(ref.ecqmId),
    officialMeasure: { name: official.measureName, version: official.version, url: official.url },
  };
  if (cacheKey) {
    if (cache.size >= 16) cache.clear();
    cache.set(cacheKey, report);
  }
  return report;
}
