/**
 * `@workwell/example-consumer` — the proof that `@workwell/measure-engine` runs on content that is not
 * WorkWell's (roadmap M-C / C2, ADR-062).
 *
 * ## What this package is for
 *
 * ADR-059 made the engine content-free: the catalog, the compiled ELM and the value-set expansions are
 * constructor input. That was an *architectural* claim, enforced by a boundary test that proves the
 * package imports no WorkWell content. It is not the same as proving the package is **usable** by someone
 * who has none.
 *
 * So this package pretends to be that someone. It:
 *   - declares **one** dependency, `@workwell/measure-engine`;
 *   - ships **its own measure** — `tetanus-booster.cql` and the ELM compiled from it, both committed here
 *     and neither referenced by the app;
 *   - builds **its own** FHIR bundle;
 *   - and evaluates, getting a real `OutcomeStatus` back.
 *
 * If the engine ever re-acquires a dependency on WorkWell's catalog, this stops compiling or stops
 * evaluating. That is a stronger signal than an import-graph assertion, because it exercises the code
 * path a real integrator takes rather than the shape of the source tree.
 *
 * ## An honest limitation
 *
 * It lives inside `backend-ts/`'s pnpm workspace, so it resolves the engine through `workspace:*` rather
 * than from a registry. It is therefore a *consumer outside the app*, not a consumer outside the repo.
 * The remaining gap — that the published tarball contains what a consumer needs — is what C4's publish
 * step closes, and pretending otherwise here would be the kind of overclaim this codebase keeps catching.
 *
 * ## What it demonstrates that the docs cannot
 *
 * **The engine requires `FHIRHelpers-4.0.1` in `elmLibraries`.** Its constructor loads that library
 * eagerly, so every consumer must supply it — a fact discovered by writing this package, not by reading
 * the API. It is committed here alongside the measure for exactly that reason.
 */
import { CqlExecutionEngine, type MeasureMeta, type MeasureOutcome } from "@workwell/measure-engine";
import tetanusElm from "./tetanus-booster.elm.json" with { type: "json" };
import fhirHelpers from "./FHIRHelpers-4.0.1.elm.json" with { type: "json" };

/** This consumer's own catalog. One measure, nothing to do with WorkWell's. */
export const MEASURES: Record<string, MeasureMeta> = {
  tetanus_booster: {
    id: "tetanus_booster",
    name: "Tetanus Booster Currency",
    library: "TetanusBooster-1.0.0",
    periodMonths: 120,
  },
};

/**
 * This consumer's own ELM. `FHIRHelpers-4.0.1` is not optional — the engine's constructor loads it
 * eagerly, so omitting it throws before any measure is evaluated.
 */
export const ELM_LIBRARIES: Record<string, unknown> = {
  "TetanusBooster-1.0.0": tetanusElm,
  "FHIRHelpers-4.0.1": fhirHelpers,
};

/** An engine configured with nothing but this package's own content. */
export function createEngine(): CqlExecutionEngine {
  return new CqlExecutionEngine({ measures: MEASURES, elmLibraries: ELM_LIBRARIES });
}

export interface ExamplePatient {
  id: string;
  birthDate: string;
  /** ISO date of a completed tetanus immunization, if any. */
  lastBoosterOn?: string;
}

/** A minimal FHIR R4 bundle — the consumer's own data shape, mapped to what the measure retrieves. */
export function buildBundle(p: ExamplePatient): unknown {
  const entries: unknown[] = [
    { resource: { resourceType: "Patient", id: p.id, birthDate: p.birthDate } },
  ];
  if (p.lastBoosterOn) {
    entries.push({
      resource: {
        resourceType: "Immunization",
        id: `${p.id}-imm`,
        status: "completed",
        patient: { reference: `Patient/${p.id}` },
        occurrenceDateTime: p.lastBoosterOn,
        vaccineCode: { coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: "115" }] },
      },
    });
  }
  return { resourceType: "Bundle", type: "collection", entry: entries };
}

/** The whole point, in one call: content in, compliance out. */
export async function evaluate(p: ExamplePatient, evaluationDate: string): Promise<MeasureOutcome> {
  return createEngine().evaluate({
    measureId: "tetanus_booster",
    patientBundle: buildBundle(p),
    evaluationDate,
  });
}
