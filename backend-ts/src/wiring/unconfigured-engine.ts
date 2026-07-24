/**
 * Fallback binding when no engine is configured: refuse, never guess (the "AI never decides
 * compliance" discipline applied to an unwired engine slot).
 *
 * Lives in `src/wiring/` (the app's composition layer), NOT `src/engine/` — it is the only consumer
 * of `@mieweb/cloud`'s binding-error machinery on the evaluation surface, and moving it here is what
 * lets the engine package ship with zero `@mieweb/*` runtime deps (extraction PR-1; engine-boundary
 * arch test).
 */
import { UnsupportedBindingError, type CloudTarget } from "@mieweb/cloud";
import type {
  EvaluateMeasureBinding,
  EvaluateMeasureInput,
  MeasureOutcome,
} from "../engine/evaluate-measure.ts";

export class UnconfiguredEngine implements EvaluateMeasureBinding {
  constructor(private readonly target: CloudTarget = "local") {}

  evaluate(_input: EvaluateMeasureInput): Promise<MeasureOutcome> {
    throw new UnsupportedBindingError("EvaluateMeasure", this.target, "no CQL engine binding configured");
  }
}
