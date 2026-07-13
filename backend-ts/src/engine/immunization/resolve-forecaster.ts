/**
 * Config-driven ImmunizationForecaster selection (ADR-029; mirrors
 * `engine/cql/resolve-value-set-resolver.ts` / `resolveDataSource` / `resolveChannel`): the
 * simulated forecaster is the default, and the REAL ICE adapter is selected only when
 * WORKWELL_IMMZ_ICE_BASE_URL is set (inert-unless-configured — the deployed demo stack leaves it
 * unset and behaves byte-identically to before). The simulated forecaster is injected as the ICE
 * adapter's fallback, so any sidecar failure degrades to it rather than erroring the advisory read.
 *
 * This module sits ABOVE both the port and the adapter (the adapter imports the port) so there is
 * no import cycle.
 */
import { realIceForecaster } from "./ice-forecaster.ts";
import {
  isIceConfigured,
  simulatedForecaster,
  type ForecastEnv,
  type ImmunizationForecaster,
} from "./immunization-forecast.ts";

export function resolveForecaster(env: ForecastEnv): ImmunizationForecaster {
  if (!isIceConfigured(env)) return simulatedForecaster;
  const baseUrl = (env.WORKWELL_IMMZ_ICE_BASE_URL ?? "").trim();
  const apiKey = (env.WORKWELL_IMMZ_ICE_API_KEY ?? "").trim() || undefined;
  return realIceForecaster({ baseUrl, apiKey }, { fallback: simulatedForecaster });
}
