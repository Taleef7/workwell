/**
 * Config-driven ImmunizationForecaster selection (ADR-029; mirrors
 * `engine/cql/resolve-value-set-resolver.ts` / `resolveDataSource` / `resolveChannel`):
 * `noHistoryForecaster` is the default, and the REAL ICE adapter is selected only when
 * WORKWELL_IMMZ_ICE_BASE_URL is set (inert-unless-configured).
 *
 * Either way there is no dose history to read yet, so ICE is given `noIceHistory` and answers
 * "no history" without being dialed (#628). WebChart immunizations are the drop-in (E12): inject
 * that source here and the configured adapter forecasts from it.
 *
 * This module sits ABOVE both the port and the adapter (the adapter imports the port) so there is
 * no import cycle.
 */
import { noIceHistory, realIceForecaster } from "./ice-forecaster.ts";
import {
  isIceConfigured,
  noHistoryForecaster,
  type ForecastEnv,
  type ImmunizationForecaster,
} from "./immunization-forecast.ts";

export function resolveForecaster(env: ForecastEnv): ImmunizationForecaster {
  if (!isIceConfigured(env)) return noHistoryForecaster;
  const baseUrl = (env.WORKWELL_IMMZ_ICE_BASE_URL ?? "").trim();
  const apiKey = (env.WORKWELL_IMMZ_ICE_API_KEY ?? "").trim() || undefined;
  return realIceForecaster({ baseUrl, apiKey }, { historySource: noIceHistory });
}
