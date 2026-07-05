/**
 * Builds the runtime CqlExecutionEngine, memoized per env object (mirrors getStores' per-env caching).
 * SAFETY: when WORKWELL_VSAC_API_KEY is unset the engine is constructed with NO resolver — byte-identical
 * to today's production default (audiogram inline path). Only when the key is set does it attach the
 * composite VSAC resolver (resolveValueSetResolver: VSAC for real OIDs, local store for urn:workwell:*).
 * Enabling VSAC changes no current measure's outcome (audiogram-vsac-parity.test.ts; ADR-008).
 */
import { CqlExecutionEngine } from "./cql-execution-engine.ts";
import { resolveValueSetResolver } from "./resolve-value-set-resolver.ts";
import { getStores, type StoresEnv } from "../../stores/factory.ts";

const cache = new WeakMap<object, Promise<CqlExecutionEngine>>();

export function engineForEnv(env: StoresEnv): Promise<CqlExecutionEngine> {
  let hit = cache.get(env as object);
  if (!hit) {
    hit = (async () => {
      const apiKey = (process.env.WORKWELL_VSAC_API_KEY ?? "").trim();
      if (!apiKey) return new CqlExecutionEngine(); // today's default — inline path, no resolver
      const stores = await getStores(env);
      const vsacEnv = {
        WORKWELL_VSAC_API_KEY: apiKey,
        WORKWELL_VSAC_BASE_URL: process.env.WORKWELL_VSAC_BASE_URL,
      };
      return new CqlExecutionEngine({ valueSetResolver: resolveValueSetResolver(vsacEnv, stores.valueSets) });
    })();
    cache.set(env as object, hit);
  }
  return hit;
}
