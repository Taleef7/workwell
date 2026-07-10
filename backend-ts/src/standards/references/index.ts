import type { OfficialMeasureReference } from "../reference-types.ts";
import { CMS122V14 } from "./cms122v14.ts";
import { CMS125V14 } from "./cms125v14.ts";

const REFERENCES: Record<string, OfficialMeasureReference> = {
  [CMS122V14.measureId]: CMS122V14,
  [CMS125V14.measureId]: CMS125V14,
};

/** The official reference for a WorkWell measure id, or undefined if none is vendored yet. */
export function referenceFor(measureId: string): OfficialMeasureReference | undefined {
  return REFERENCES[measureId];
}
