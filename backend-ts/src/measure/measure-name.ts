/**
 * A measure's display name, for ANY runnable measure.
 *
 * `MEASURES` (`engine/cql/measure-registry.ts`) is the AUTHORED registry — it is the authority on which
 * measures have authored CQL, and on nothing else. It holds `cms122`/`cms125` but NOT the official-only
 * ids (`cms2`, `cms130`, `cms165`), whose logic is the vendored CMS artifact rather than CQL in this
 * repo (ADR-072).
 *
 * Every `MEASURES[id]!.name` was therefore a latent crash that fires the moment a deployment routes one
 * of the three — which is precisely what this milestone makes possible, so the failure would have
 * arrived with the first flip and taken the run with it. The catalog carries a name for all of them,
 * and falling back to the id keeps this total rather than trading one throw for another.
 */
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_CATALOG } from "./measure-catalog.ts";

export function measureDisplayName(measureId: string): string {
  return MEASURES[measureId]?.name ?? MEASURE_CATALOG.find((m) => m.id === measureId)?.name ?? measureId;
}
