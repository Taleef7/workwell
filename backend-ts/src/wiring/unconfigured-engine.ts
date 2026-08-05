/**
 * Fallback binding when no engine is configured: refuse, never guess (the "AI never decides
 * compliance" discipline applied to an unwired engine slot).
 *
 * Lives in `src/wiring/` (the app's composition layer), NOT `src/engine/` — it is the only consumer
 * of `@mieweb/cloud`'s binding-error machinery on the evaluation surface, and moving it here is what
 * lets the engine package ship with zero `@mieweb/*` runtime deps (extraction PR-1; engine-boundary
 * containment test).
 *
 * **Deliberately unreferenced.** It has had zero importers since it was written (true on `main` before
 * this move too) — it is kept, not deleted, because it is the reference implementation of the
 * `EvaluateMeasureBinding` refusal contract for a `@mieweb/cloud` target that has no engine wired:
 * a target must fail loudly rather than return a fabricated outcome. If a future target selects
 * bindings by capability, this is what it selects when the engine slot is empty. Delete it only
 * together with that contract.
 */
import { UnsupportedBindingError, type CloudTarget } from "@mieweb/cloud";
import type {
  EvaluateMeasureBinding,
  EvaluateMeasureInput,
  MeasureOutcome,
} from "@workwell/measure-engine";

export class UnconfiguredEngine implements EvaluateMeasureBinding {
  constructor(private readonly target: CloudTarget = "local") {}

  evaluate(_input: EvaluateMeasureInput): Promise<MeasureOutcome> {
    throw new UnsupportedBindingError("EvaluateMeasure", this.target, "no CQL engine binding configured");
  }
}
