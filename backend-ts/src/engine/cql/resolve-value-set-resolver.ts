/**
 * Config-driven ValueSetResolver selection (mirrors resolveDataSource/resolveForecaster): the plain
 * local StoreValueSetResolver by default (today's behavior — inert), and the CompositeValueSetResolver
 * (VSAC for real OIDs, local fallback for urn:workwell:*) only when WORKWELL_VSAC_API_KEY is set.
 * Inert-unless-configured: setting the key never changes a current measure's outcome (parity-tested).
 */
import type { ValueSetResolver } from "./value-set-resolver.ts";
import { StoreValueSetResolver } from "./value-set-resolver.ts";
import { VsacValueSetResolver } from "./vsac-value-set-resolver.ts";
import { CompositeValueSetResolver } from "./composite-value-set-resolver.ts";
import { httpVsacClient } from "./vsac-client.ts";
import type { ValueSetStore } from "../../stores/value-set-store.ts";

export interface VsacEnv {
  WORKWELL_VSAC_API_KEY?: string;
  WORKWELL_VSAC_BASE_URL?: string;
}

const DEFAULT_BASE = "https://cts.nlm.nih.gov/fhir";

/**
 * Pure predicate for the VSAC key-gate — the same condition `resolveValueSetResolver` and
 * `engineForEnv` use to decide whether to attach the composite VSAC resolver. The single source of
 * truth for both, and for the boot-time seam inventory (#260); never duplicate this parsing.
 */
export function isVsacConfigured(env: VsacEnv): boolean {
  return Boolean((env.WORKWELL_VSAC_API_KEY ?? "").trim());
}

export function resolveValueSetResolver(env: VsacEnv, store: ValueSetStore): ValueSetResolver {
  const storeResolver = new StoreValueSetResolver(store);
  if (!isVsacConfigured(env)) return storeResolver;
  const apiKey = (env.WORKWELL_VSAC_API_KEY ?? "").trim();
  const baseUrl = (env.WORKWELL_VSAC_BASE_URL ?? "").trim() || DEFAULT_BASE;
  const vsac = new VsacValueSetResolver(httpVsacClient({ baseUrl, apiKey }));
  return new CompositeValueSetResolver(vsac, storeResolver);
}
