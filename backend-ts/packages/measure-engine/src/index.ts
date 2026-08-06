/**
 * `@work-well/measure-engine` — the headless "given a patient bundle and a measure, are they
 * compliant?" engine. Two runtime dependencies, `cql-execution` and `cql-exec-fhir`, and no
 * WorkWell content of any kind.
 *
 * ## What it is
 *
 * Executes pre-compiled ELM (CQL translated ahead of time — no JVM, no translator at runtime)
 * against a FHIR R4 patient bundle, and returns per-define results as structured evidence. It is
 * `node:fs`-free, so it runs unchanged on a Node container, a Cloudflare-style worker, or in a
 * browser bundle.
 *
 * ## What it deliberately does NOT contain (ADR-052, decided by ADR-059)
 *
 * The measure CATALOG, the compiled ELM, and any offline value-set expansions are **injected** at
 * construction. WorkWell's own registry names occupational measures and its bundled expansions are,
 * by their own docblock, "the codes the synthetic corpus stamps" — nobody consuming a measure engine
 * wants either. The same reasoning that keeps our synthetic employee directory out keeps these out:
 *
 * ```ts
 * const engine = new CqlExecutionEngine({ measures, elmLibraries, expansionFallback });
 * const outcome = await engine.evaluate({ measureId, patientBundle, evaluationDate });
 * ```
 *
 * `evaluate` also accepts `elm` and `metaOverride`, so a consumer can run a measure the injected
 * catalog has never heard of.
 *
 * ## The boundary is enforced, not documented
 *
 * `package-boundary.test.ts` walks the import closure from THIS file and refuses a third dependency,
 * any `node:` builtin, any relative import escaping the package, and any import of WorkWell content.
 * `src/engine/engine-boundary.test.ts` on the app side refuses a deep import past this module.
 */

export type {
  OutcomeStatus,
  ExpressionResult,
  OfficialEvidence,
  MeasureOutcome,
  EvaluateMeasureInput,
  EvaluateMeasureBinding,
} from "./evaluate-measure.ts";

export type { MeasureMeta } from "./cql/measure-meta.ts";

export {
  CqlExecutionEngine,
  deriveInInitialPopulation,
  type MeasureContent,
} from "./cql/cql-execution-engine.ts";

export {
  evaluateExpressions,
  type EvaluateExpressionsOptions,
} from "./cql/evaluate-expressions.ts";

export {
  StoreValueSetResolver,
  buildCodeService,
  type CqlCode,
  type ValueSetResolver,
  type ValueSetSource,
  type ValueSetSourceRecord,
} from "./cql/value-set-resolver.ts";

export {
  CompositeValueSetResolver,
  isVsacOid,
  vsacOid,
} from "./cql/composite-value-set-resolver.ts";

export { VsacValueSetResolver } from "./cql/vsac-value-set-resolver.ts";

export {
  isVsacConfigured,
  resolveValueSetResolver,
  type VsacEnv,
} from "./cql/resolve-value-set-resolver.ts";

export {
  fixtureVsacClient,
  httpVsacClient,
  type VsacClient,
  type VsacClientConfig,
  type VsacCode,
  type VsacExpandOptions,
  type VsacExpansion,
} from "./cql/vsac-client.ts";

export {
  fhirNativeExecutor,
  isSqlPushdownSelected,
  resolveMeasureExecutor,
  sqlPushdownExecutor,
  type MeasureExecutor,
  type MeasureExecutorEnv,
  type MeasureExecutorKind,
} from "./measure-executor.ts";
