/**
 * Rule-params → CQL codegen (E11.1, ADR-015). Emits canonical CQL (inline-code pattern) for two rule
 * shapes; behaviorally equivalent (same `Outcome Status`) to the hand-written CQL, proven by
 * codegen-parity.test.ts. CQL stays the sole execution + standards layer (ADR-008); this only *produces*
 * CQL. Define names are chosen to satisfy the roster's deriveWhyFlagged regexes
 * (/^most recent .*date$/i, /^days since/i, waiver/contraindication, "Dose Count").
 * E11.2a adds optional titer (series), grace (windowed), and a windowed Refused define — all back-compatible (absent ⇒ E11.1 output).
 */
export interface CodeBinding {
  code: string;
  valueSet: string;
}
export interface CodegenBindings {
  enrollment: CodeBinding;
  waiver: CodeBinding;
  event: CodeBinding & { type: "procedure" | "immunization" | "observation" };
  refusal?: CodeBinding;
  titer?: { code: string; valueSet: string; minValue: number };
}
export type Rule =
  | { type: "series-completion"; requiredDoses: number; allowPositiveTiter?: boolean }
  | { type: "windowed-recency"; windowDays: number; dueSoonDays: number; gracePeriodDays?: number };

export interface GenerateCqlInput {
  library: string;
  version: string;
  rule: Rule;
  bindings: CodegenBindings;
}

const header = (library: string, version: string): string =>
  `library ${library} version '${version}'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

parameter "Measurement Period" Interval<DateTime>
context Patient
`;

/** `exists([Condition] … inline system/code)` — the enrollment/waiver/refusal pattern. */
const conditionDefine = (name: string, b: CodeBinding): string =>
  `
define "${name}":
  exists([Condition] C
    where exists(C.code.coding x where x.system = '${b.valueSet}' and x.code = '${b.code}'))
`;

function seriesCompletion(input: GenerateCqlInput): string {
  const b = input.bindings;
  if (b.event.type !== "immunization") throw new Error("series-completion requires event.type=immunization");
  const rule = input.rule as { requiredDoses: number; allowPositiveTiter?: boolean };
  const n = rule.requiredDoses;
  const titerEnabled = rule.allowPositiveTiter === true && b.titer != null;
  const titerDefine = titerEnabled
    ? `
define "Has Positive Titer":
  exists([Observation] O
    where exists(O.code.coding C where C.system = '${b.titer!.valueSet}' and C.code = '${b.titer!.code}')
      and (O.value as FHIR.Quantity).value >= ${b.titer!.minValue})
`
    : "";
  const seriesComplete = titerEnabled
    ? `"Enrolled" and not "Has Contraindication" and ("Dose Count" >= ${n} or "Has Positive Titer")`
    : `"Enrolled" and not "Has Contraindication" and "Dose Count" >= ${n}`;
  return (
    header(input.library, input.version) +
    conditionDefine("Enrolled", b.enrollment) +
    conditionDefine("Has Contraindication", b.waiver) +
    (b.refusal ? conditionDefine("Refused", b.refusal) : "") +
    titerDefine +
    `
define "Dose Count":
  Count([Immunization] I
    where I.status = 'completed'
      and exists(I.vaccineCode.coding C where C.system = '${b.event.valueSet}' and C.code = '${b.event.code}'))

define "Series Complete":
  ${seriesComplete}

define "Excluded": "Has Contraindication"

define "Initial Population": "Enrolled" or "Has Contraindication"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Series Complete" then 'COMPLIANT'
  else 'MISSING_DATA'
`
  );
}

function windowedRecency(input: GenerateCqlInput): string {
  const b = input.bindings;
  if (b.event.type !== "procedure") throw new Error("windowed-recency (E11.1) requires event.type=procedure");
  const rule = input.rule as { windowDays: number; dueSoonDays: number; gracePeriodDays?: number };
  const { windowDays, dueSoonDays } = rule;
  const compliantMax = windowDays - dueSoonDays;
  const overdueThreshold = windowDays + (rule.gracePeriodDays ?? 0);
  return (
    header(input.library, input.version) +
    conditionDefine("Enrolled", b.enrollment) +
    conditionDefine("Has Waiver", b.waiver) +
    (b.refusal ? conditionDefine("Refused", b.refusal) : "") +
    `
define "Most Recent Event Date":
  Last(
    [Procedure] P
      where exists(P.code.coding C where C.system = '${b.event.valueSet}' and C.code = '${b.event.code}')
      sort by (performed as FHIR.dateTime)
  ).performed as FHIR.dateTime

define "Days Since Last Event":
  difference in days between
    Coalesce("Most Recent Event Date", @1900-01-01T00:00:00.0)
    and Now()

define "Compliant":
  "Enrolled" and not "Has Waiver" and "Days Since Last Event" <= ${compliantMax}

define "Due Soon":
  "Enrolled" and not "Has Waiver" and "Days Since Last Event" > ${compliantMax} and "Days Since Last Event" <= ${overdueThreshold}

define "Overdue":
  "Enrolled" and not "Has Waiver" and "Days Since Last Event" > ${overdueThreshold}

define "Missing Data":
  "Enrolled" and not "Has Waiver" and "Most Recent Event Date" is null

define "Excluded": "Has Waiver"

define "Initial Population": "Enrolled" or "Has Waiver"

define "Outcome Status":
  if "Excluded" then 'EXCLUDED'
  else if "Missing Data" then 'MISSING_DATA'
  else if "Overdue" then 'OVERDUE'
  else if "Due Soon" then 'DUE_SOON'
  else if "Compliant" then 'COMPLIANT'
  else 'MISSING_DATA'
`
  );
}

export function generateCql(input: GenerateCqlInput): string {
  switch (input.rule.type) {
    case "series-completion":
      return seriesCompletion(input);
    case "windowed-recency":
      return windowedRecency(input);
    default:
      throw new Error(`unknown rule.type '${(input.rule as { type: string }).type}'`);
  }
}
