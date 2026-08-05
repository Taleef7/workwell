/**
 * `MeasureMeta` — what the engine needs to know about a measure in order to run it.
 *
 * The **shape** is the package's; the **catalog** is the consumer's (ADR-059). WorkWell's own
 * 15-measure registry lives app-side in `src/engine/cql/measure-registry.ts` and is handed to
 * `CqlExecutionEngine` at construction, exactly like the ELM it names. That split is the whole
 * point of the extraction: a consumer of a measure engine wants the engine, not our catalog.
 */
export interface MeasureMeta {
  id: string;
  name: string;
  /** Key into the injected `elmLibraries` map (WorkWell's are files under `src/engine/cql/elm`). */
  library: string;
  /** Months before the eval date the Measurement Period starts (0 = single-day). */
  periodMonths: number;
  /** ELM library used in value-set-expansion mode (E3.2); falls back to `library` when absent. */
  expansionLibrary?: string;
  /** Value-set URLs the expansion-mode library references (expanded into the CodeService). */
  valueSets?: string[];
  /** Regulatory jurisdiction this measure's spec belongs to (E14 / #186). Defaults to "US" when absent. */
  jurisdiction?: string;
}
