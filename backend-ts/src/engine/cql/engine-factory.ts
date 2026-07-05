/**
 * Builds the runtime CqlExecutionEngine for an evaluation.
 *
 * SAFETY (ADR-008): when WORKWELL_VSAC_API_KEY is unset the engine has NO resolver — byte-identical to
 * today's production default (audiogram inline path). Only when the key is set does it attach the
 * composite VSAC resolver (VSAC for OIDs, local store for urn:workwell:*). Enabling VSAC changes no
 * current measure's outcome (audiogram-vsac-parity.test.ts).
 *
 * FRESHNESS (Codex P1): on the keyed path a FRESH engine + resolver is built per call and NOT cached
 * process-wide. The composite's store tier (StoreValueSetResolver) snapshots store.listAll() for its own
 * lifetime, so a process-cached engine would freeze that snapshot — a first evaluation that ran before
 * the `urn:workwell:*` value sets were seeded, or an operator value-set edit, would then serve
 * stale/empty expansions until restart. A resolver built per evaluation (created once per run in the
 * route handler → one consistent snapshot per run; a fresh snapshot next run) always reflects the
 * current value sets. Engine construction is cheap (FHIRHelpers ELM is a bundled lookup, not a parse),
 * so this is not a hot-path cost, and VSAC's own value sets are externally immutable, so the per-run
 * VSAC memoization within the resolver is sufficient.
 */
import { CqlExecutionEngine } from "./cql-execution-engine.ts";
import { resolveValueSetResolver } from "./resolve-value-set-resolver.ts";
import { getStores, type StoresEnv } from "../../stores/factory.ts";

// Unkeyed default: a single shared, stateless engine (no resolver → inline path). It holds no
// env-specific or value-set state, so one instance is correct for every env and matches the prior
// module-singleton behavior — nothing to freeze.
const inlineEngine = new CqlExecutionEngine();

export async function engineForEnv(env: StoresEnv): Promise<CqlExecutionEngine> {
  const apiKey = (process.env.WORKWELL_VSAC_API_KEY ?? "").trim();
  if (!apiKey) return inlineEngine; // today's default — inline path, no resolver
  const stores = await getStores(env);
  const vsacEnv = {
    WORKWELL_VSAC_API_KEY: apiKey,
    WORKWELL_VSAC_BASE_URL: process.env.WORKWELL_VSAC_BASE_URL,
  };
  // Fresh per call — never a process-frozen store snapshot (Codex P1).
  return new CqlExecutionEngine({ valueSetResolver: resolveValueSetResolver(vsacEnv, stores.valueSets) });
}
