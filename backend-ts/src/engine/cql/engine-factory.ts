/**
 * Builds the runtime CqlExecutionEngine for an evaluation.
 *
 * SAFETY (ADR-008): when no VSAC key is configured the engine has NO resolver — byte-identical to
 * today's production default (audiogram inline path). Only with the key set does it attach the composite
 * VSAC resolver (VSAC for OIDs, local store for urn:workwell:*). Enabling VSAC changes no current
 * measure's outcome (audiogram-vsac-parity.test.ts).
 *
 * CONFIG SOURCE (Codex P2): the VSAC credentials are read from the worker `env` first (how DATABASE_URL,
 * auth, CORS, and every other WORKWELL_* runtime flag are supplied on @mieweb/cloud), falling back to
 * `process.env` for Node-host / CLI contexts. Reading `process.env` alone would silently keep a worker
 * deployment that only sets `env.WORKWELL_VSAC_API_KEY` on the inline path.
 *
 * SEED GUARD (Codex P2): expansion mode needs the local `urn:workwell:*` value sets seeded (audiogram →
 * `urn:workwell:vs:audiogram-procedures`). That seed runs lazily via the /api/measures initializer, not
 * on the runs/cases/scheduler paths — so on a fresh, unseeded DB whose first operation is a run or the
 * scheduler, the local set would expand to `[]` and mis-evaluate. Until the store has value sets, stay on
 * the inline engine — byte-equal to store-expansion for the urn:workwell measures (parity-tested), and no
 * real-OID (VSAC-tier) measure exists yet, so nothing is lost; once seeded, the resolver engine is used.
 *
 * FRESHNESS (Codex P1): on the keyed path a FRESH engine + resolver is built per call and NOT cached
 * process-wide. The composite's store tier (StoreValueSetResolver) snapshots store.listAll() for its own
 * lifetime, so a process-cached engine would freeze that snapshot (an operator value-set edit would then
 * serve stale expansions until restart). A resolver built per evaluation (created once per run in the
 * route handler → one consistent snapshot per run; a fresh snapshot next run) always reflects the current
 * value sets. Engine construction is cheap (FHIRHelpers ELM is a bundled lookup, not a parse), and VSAC's
 * own value sets are externally immutable, so the per-run VSAC memoization within the resolver suffices.
 */
import { CqlExecutionEngine } from "./cql-execution-engine.ts";
import { resolveValueSetResolver, type VsacEnv } from "./resolve-value-set-resolver.ts";
import { getStores, type StoresEnv } from "../../stores/factory.ts";

// Unkeyed default (and the not-yet-seeded fallback): a single shared, stateless engine (no resolver →
// inline path). It holds no env-specific or value-set state, so one instance is correct for every env and
// matches the prior module-singleton behavior — nothing to freeze.
const inlineEngine = new CqlExecutionEngine();

export async function engineForEnv(env: StoresEnv & VsacEnv): Promise<CqlExecutionEngine> {
  // env-first (worker deployments), process.env fallback (Node host / CLIs).
  const apiKey = (env.WORKWELL_VSAC_API_KEY ?? process.env.WORKWELL_VSAC_API_KEY ?? "").trim();
  if (!apiKey) return inlineEngine; // today's default — inline path, no resolver

  const stores = await getStores(env);
  // Local value sets not seeded yet → inline (byte-equal for urn:workwell measures) until they exist.
  if (await stores.valueSets.isEmpty()) return inlineEngine;

  const vsacEnv: VsacEnv = {
    WORKWELL_VSAC_API_KEY: apiKey,
    WORKWELL_VSAC_BASE_URL: env.WORKWELL_VSAC_BASE_URL ?? process.env.WORKWELL_VSAC_BASE_URL,
  };
  // Fresh per call — never a process-frozen store snapshot (Codex P1).
  return new CqlExecutionEngine({ valueSetResolver: resolveValueSetResolver(vsacEnv, stores.valueSets) });
}
