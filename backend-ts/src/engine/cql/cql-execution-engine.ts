/**
 * `CqlExecutionEngine` — the production `EvaluateMeasure` compute binding (#106).
 *
 * Executes committed ELM (compiled from CQL by scripts/compile-measures.mjs via
 * @cqframework/cql — pure Node, no JVM) against a FHIR R4 patient bundle using
 * cql-execution + cql-exec-fhir. Proven byte-equal to the Java engine across all
 * 10 measures × 4 scenarios (backend-ts/spike). This is the headless
 * "given a patient and a measure, are they compliant?" engine, with no JVM.
 *
 * ELM is bundled via static imports (elm/index.ts) — NO node:fs at import or
 * runtime — so the worker is portable across every @mieweb/cloud target
 * (Cloudflare Workers included), not just the Node container.
 */
// eslint-disable-next-line import/no-unresolved
import cql from "cql-execution";
import cqlfhir from "cql-exec-fhir";
import type {
  EvaluateMeasureBinding,
  EvaluateMeasureInput,
  ExpressionResult,
  MeasureOutcome,
  OutcomeStatus,
} from "../evaluate-measure.ts";
import { MEASURES } from "./measure-registry.ts";
import { ELM_LIBRARIES } from "./elm/index.ts";
import { buildCodeService, type ValueSetResolver } from "./value-set-resolver.ts";

const OUTCOMES: ReadonlySet<string> = new Set(["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"]);

const subtractMonths = (isoDate: string, months: number): string => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
};

/** Render a CQL value into the evidence_json contract (ADR-002): scalars + ISO dates. */
const renderDefine = (v: unknown): unknown => {
  if (v == null) return null;
  if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  const obj = v as { value?: unknown; toString?: () => string };
  const inner = obj.value ?? (typeof obj.toString === "function" ? obj.toString() : null);
  if (typeof inner === "string") {
    const t = Date.parse(inner);
    return !Number.isNaN(t) && /\d{4}-\d{2}-\d{2}T/.test(inner) ? new Date(t).toISOString() : inner;
  }
  if (typeof inner === "number") return inner;
  return null; // non-scalar intermediate (FHIR resource/quantity) — not part of the contract
};

export class CqlExecutionEngine implements EvaluateMeasureBinding {
  private readonly fhirHelpers: unknown;

  constructor(private readonly opts: { valueSetResolver?: ValueSetResolver } = {}) {
    this.fhirHelpers = this.loadElm("FHIRHelpers-4.0.1");
  }

  private loadElm(library: string): unknown {
    const elm = ELM_LIBRARIES[library];
    if (!elm) throw new Error(`ELM not bundled for library '${library}' (re-run pnpm compile-measures)`);
    return elm;
  }

  async evaluate(input: EvaluateMeasureInput): Promise<MeasureOutcome> {
    const meta = MEASURES[input.measureId];
    if (!meta) throw new Error(`unknown measure '${input.measureId}'`);
    const evalDate = input.evaluationDate ?? new Date().toISOString().slice(0, 10);

    const expand = this.opts.valueSetResolver != null && meta.expansionLibrary != null && meta.valueSets != null;
    const libraryName = expand ? meta.expansionLibrary! : meta.library;
    const library = new cql.Library(this.loadElm(libraryName), new cql.Repository({ FHIRHelpers: this.fhirHelpers }));
    const startDate = meta.periodMonths > 0 ? subtractMonths(evalDate, meta.periodMonths) : evalDate;
    const measurementPeriod = new cql.Interval(
      cql.DateTime.parse(`${startDate}T00:00:00.0`),
      cql.DateTime.parse(`${evalDate}T23:59:59.0`),
      true,
      true,
    );
    const codeService = expand
      ? await buildCodeService(this.opts.valueSetResolver!, meta.valueSets!)
      : new cql.CodeService({});
    const executor = new cql.Executor(library, codeService, { "Measurement Period": measurementPeriod });

    const patientSource = cqlfhir.PatientSource.FHIRv401();
    patientSource.loadBundles([input.patientBundle]);
    const results = await executor.exec(patientSource, cql.DateTime.parse(`${evalDate}T00:00:00.0`));

    const entries = Object.entries(results.patientResults) as Array<[string, Record<string, unknown>]>;
    const first = entries[0];
    if (!first) throw new Error("no patient in bundle to evaluate");
    const [subjectId, defines] = first;

    const status = String(defines["Outcome Status"] ?? "MISSING_DATA");
    const outcome = (OUTCOMES.has(status) ? status : "MISSING_DATA") as OutcomeStatus;
    const expressionResults: ExpressionResult[] = Object.entries(defines)
      .filter(([name]) => name !== "Patient")
      .map(([define, value]) => ({ define, result: renderDefine(value) }));

    return { subjectId, measure: meta.name, outcome, evidence: { expressionResults } };
  }
}
