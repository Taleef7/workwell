/**
 * E12 (#184) pluggable patient-data ingress — public surface.
 * DB-less JSON-bucket evaluation + the WebChart HTTP/FHIR adapter (E12 PR-2, transport-injected).
 */
export {
  evaluateBundle,
  evaluateBatch,
  type EvaluateBundleOptions,
  type BatchItemResult,
  type BatchResult,
} from "./evaluate-bundle.ts";
export {
  type PatientDataSource,
  jsonBucketDataSource,
  webChartDataSource,
  type WebChartConfig,
  type DataSourceEnv,
  resolveDataSource,
  evaluateSource,
} from "./data-source.ts";
export { normalizeWebChartBundle } from "./webchart/normalize.ts";
export {
  reconcileCoding,
  reconcileCodings,
  crosswalkMeasureIds,
  type Coding,
} from "./webchart/terminology.ts";
export {
  type WebChartClient,
  fixtureWebChartClient,
  httpWebChartClient,
} from "./webchart/webchart-client.ts";
