/**
 * E12 (#184) pluggable patient-data ingress — public surface.
 * DB-less JSON-bucket evaluation today; WebChart adapter is an inert stub until E12 PR-2.
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
