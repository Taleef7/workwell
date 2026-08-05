/**
 * `createWorkwellEngine` — `@workwell/measure-engine` configured with WorkWell's own content.
 *
 * The engine takes its measure catalog, compiled ELM and offline value-set expansions as constructor
 * input (ADR-059); this is the one place in the app that supplies them. Every consumer that used to
 * write `new CqlExecutionEngine()` calls this instead, so the content wiring exists once rather than at
 * ~45 construction sites — and a consumer OUTSIDE this repo gets the engine without our catalog.
 *
 * It lives inside `src/engine/` on purpose: `engine-boundary.test.ts` proves that directory reaches
 * nothing outside itself, and the three content modules it wires are all local to it.
 */
import { CqlExecutionEngine, type ValueSetResolver } from "@workwell/measure-engine";
import { MEASURES } from "./measure-registry.ts";
import { ELM_LIBRARIES } from "./elm/index.ts";
import { withBundledEcqmFallback } from "./bundled-ecqm-expansions.ts";

export function createWorkwellEngine(
  opts: { valueSetResolver?: ValueSetResolver } = {},
): CqlExecutionEngine {
  return new CqlExecutionEngine({
    measures: MEASURES,
    elmLibraries: ELM_LIBRARIES,
    expansionFallback: withBundledEcqmFallback,
    ...opts,
  });
}
