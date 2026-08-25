/**
 * CQL evaluation result → FHIR `Parameters` (#474 — the `$cql` Evaluation Service response body).
 *
 * The mapping is the CQL IG's (FHIR-56226 for numeric intervals), implemented against what
 * `cqframework/cql-tests-runner`'s extractor chain actually reads back — see the contract notes in
 * `cql-result-parameters.test.ts`. Two conventions are load-bearing and easy to get wrong:
 *
 *   - **Absence must be SAID, not omitted.** `null`, the empty list and the empty tuple each get an
 *     explicit `_valueBoolean` extension (`data-absent-reason`, `cqf-isEmptyList`, `cqf-isEmptyTuple`);
 *     an absent parameter reads as "no result", which is a different answer.
 *   - **The reader derives interval closedness from boundary PRESENCE.** A numeric boundary we emit is
 *     read as closed whatever we meant, so open Integer boundaries are closed-normalized (step 1) and
 *     open Decimal boundaries by the CQL Decimal step (1e-8). That is successor/predecessor semantics,
 *     the same normalization CQL itself defines for `Interval` equality.
 *
 * Values come from `cql-execution`, whose runtime types are detected by their own instance flags
 * (`isDate`/`isDateTime`/`isTime`, `isQuantity`, `isInterval`, `isCode`, `isConcept`, `isRatio`) —
 * detection by flag rather than `instanceof` so this module needs no dependency on the engine package.
 */

const UCUM = "http://unitsofmeasure.org";
const DATA_ABSENT = "http://hl7.org/fhir/StructureDefinition/data-absent-reason";
const IS_EMPTY_LIST = "http://hl7.org/fhir/StructureDefinition/cqf-isEmptyList";
const IS_EMPTY_TUPLE = "http://hl7.org/fhir/StructureDefinition/cqf-isEmptyTuple";
const CQL_TYPE = "http://hl7.org/fhir/StructureDefinition/cqf-cqlType";

/** CQL's Decimal step — successor/predecessor granularity per the spec (8 decimal places). */
const DECIMAL_STEP = 1e-8;
const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

export interface FhirParameter {
  name: string;
  [key: string]: unknown;
}

export interface FhirParameters {
  resourceType: "Parameters";
  parameter: FhirParameter[];
}

/** `true` when the engine value carries the given cql-execution flag (boolean or nullary method). */
function flag(v: object, name: string): boolean {
  const f = (v as Record<string, unknown>)[name];
  return f === true || (typeof f === "function" && (f as () => unknown).call(v) === true);
}

function absent(name: string, url: string, ext: Record<string, unknown>): FhirParameter {
  return { name, _valueBoolean: { extension: [{ url, ...ext }] } };
}

const nullParam = (name: string) => absent(name, DATA_ABSENT, { valueCode: "unknown" });
const emptyListParam = (name: string) => absent(name, IS_EMPTY_LIST, { valueBoolean: true });
const emptyTupleParam = (name: string) => absent(name, IS_EMPTY_TUPLE, { valueBoolean: true });

function unityQuantity(value: number): Record<string, unknown> {
  return { value, system: UCUM, code: "1" };
}

function quantityValue(q: { value?: unknown; unit?: unknown }): Record<string, unknown> {
  const unit = typeof q.unit === "string" && q.unit !== "" ? q.unit : "1";
  return { value: q.value, unit, system: UCUM, code: unit };
}

/**
 * Close-normalize one numeric boundary. `null` boundaries stay null (an unbounded end is expressed by
 * omitting the Range/Period element). `isLow` decides the direction the open boundary moves.
 */
function closedBoundary(
  value: number | null,
  closed: boolean,
  isLow: boolean,
  step: number,
): number | null {
  if (value === null || closed) return value;
  return isLow ? value + step : value - step;
}

interface IntervalLike {
  low: unknown;
  high: unknown;
  lowClosed: boolean;
  highClosed: boolean;
}

function intervalParam(name: string, v: IntervalLike): FhirParameter {
  const { low, high } = v;
  const sample = low ?? high;

  // Temporal intervals → Period. FHIR Period boundaries are dateTimes; the cqf-cqlType extension is
  // what tells the reader whether the points are really Dates or Times (the runner strips the
  // artifacts of the mapping based on it).
  if (sample !== null && typeof sample === "object") {
    if (flag(sample, "isTime") || flag(sample, "isDate") || flag(sample, "isDateTime")) {
      const point = flag(sample, "isTime") ? "Time" : flag(sample, "isDate") ? "Date" : "DateTime";
      // Open temporal boundaries are closed-normalized just like the numeric branch (Codex P2 on
      // #481): the reader infers every present Period endpoint as closed, so an open-low Date
      // interval emitted raw would round-trip WIDER than the true interval. cql-execution's own
      // successor()/predecessor() honor the value's precision; if a boundary cannot step (already
      // at the type's extreme), the raw value is the least-wrong fallback.
      const step = (b: unknown, closed: boolean, fn: "successor" | "predecessor"): object | null => {
        if (b === null || b === undefined) return null;
        if (closed) return b as object;
        try {
          const stepped = (b as Record<string, unknown>)[fn];
          return typeof stepped === "function" ? ((stepped as () => object).call(b) ?? (b as object)) : (b as object);
        } catch {
          return b as object;
        }
      };
      const lowT = step(low, v.lowClosed, "successor");
      const highT = step(high, v.highClosed, "predecessor");
      const period: Record<string, unknown> = {};
      if (lowT !== null) period.start = temporalString(lowT);
      if (highT !== null) period.end = temporalString(highT);
      return {
        name,
        extension: [{ url: CQL_TYPE, valueString: `Interval<System.${point}>` }],
        valuePeriod: period,
      };
    }
    if (flag(sample, "isQuantity")) {
      // Open boundaries closed-normalize by the CQL Decimal step on the VALUE (Codex round 2 on
      // #481): cql-execution quantities carry no successor()/predecessor() (probed), and presence
      // means closed to the reader, same as every other interval branch.
      const stepQ = (b: unknown, closed: boolean, direction: 1 | -1): Record<string, unknown> | null => {
        if (b === null || b === undefined) return null;
        const q = quantityValue(b as { value?: unknown; unit?: unknown });
        if (!closed && typeof q.value === "number") {
          q.value = Number((q.value + direction * DECIMAL_STEP).toFixed(8));
        }
        return q;
      };
      const lowQ = stepQ(low, v.lowClosed, 1);
      const highQ = stepQ(high, v.highClosed, -1);
      const range: Record<string, unknown> = {};
      if (lowQ !== null) range.low = lowQ;
      if (highQ !== null) range.high = highQ;
      return {
        name,
        extension: [{ url: CQL_TYPE, valueString: "Interval<System.Quantity>" }],
        valueRange: range,
      };
    }
  }

  // Numeric interval (FHIR-56226): unity-coded Range + declared point type. Integer when every present
  // boundary is a whole number — the engine's numbers carry no static type, so this is the honest
  // best available discrimination (a whole-valued Decimal interval will grade with the Integer step).
  const nums = [low, high].filter((b): b is number => typeof b === "number");
  const isInteger = nums.length > 0 && nums.every((n) => Number.isInteger(n));
  const step = isInteger ? 1 : DECIMAL_STEP;
  const lowN = closedBoundary(typeof low === "number" ? low : null, v.lowClosed, true, step);
  const highN = closedBoundary(typeof high === "number" ? high : null, v.highClosed, false, step);
  const range: Record<string, unknown> = {};
  if (lowN !== null) range.low = unityQuantity(lowN);
  if (highN !== null) range.high = unityQuantity(highN);
  return {
    name,
    extension: [
      { url: CQL_TYPE, valueString: `Interval<System.${isInteger ? "Integer" : "Decimal"}>` },
    ],
    valueRange: range,
  };
}

/** Renders a cql-execution temporal value in FHIR form (its own toString is already ISO-shaped). */
function temporalString(v: object): string {
  const s = String((v as { toString(): string }).toString());
  // A cql Time renders as `T10:30:00.000` (or with the runtime's placeholder date) — FHIR valueTime
  // and Period boundaries carry no leading `T` marker of their own.
  return s.startsWith("T") ? s.slice(1) : s;
}

function scalarParam(name: string, v: unknown): FhirParameter {
  switch (typeof v) {
    case "boolean":
      return { name, valueBoolean: v };
    case "number":
      return Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX
        ? { name, valueInteger: v }
        : { name, valueDecimal: v };
    case "string":
      return { name, valueString: v };
    case "object":
      break;
    default:
      // symbol/function/bigint — nothing in the engine returns these; refuse loudly rather than
      // serializing something the reader will misread.
      throw new Error(`unserializable CQL result of type ${typeof v}`);
  }

  const obj = v as Record<string, unknown> & object;

  // A PLAIN object is a CQL Tuple and nothing else: cql-execution's quantities, intervals,
  // temporals, codes and concepts are all class instances. Discriminating on the prototype first
  // means a tuple whose field names collide with the flags below (`Tuple { lowClosed: true, … }`,
  // `Tuple { isTime: true }`) still serializes as a tuple instead of a corrupted Range/Time
  // (review finding on #481).
  const proto = Object.getPrototypeOf(obj) as object | null;
  if (proto === Object.prototype || proto === null) {
    const entries = Object.entries(obj);
    if (entries.length === 0) return emptyTupleParam(name);
    return { name, part: entries.flatMap(([field, fieldValue]) => valueToParams(field, fieldValue)) };
  }

  if (flag(obj, "isTime")) return { name, valueTime: temporalString(obj) };
  if (flag(obj, "isDate")) return { name, valueDate: temporalString(obj) };
  if (flag(obj, "isDateTime")) return { name, valueDateTime: temporalString(obj) };
  if (flag(obj, "isQuantity")) return { name, valueQuantity: quantityValue(obj as { value?: unknown; unit?: unknown }) };
  if (flag(obj, "isRatio")) {
    const r = obj as { numerator?: { value?: unknown; unit?: unknown }; denominator?: { value?: unknown; unit?: unknown } };
    return {
      name,
      valueRatio: {
        ...(r.numerator ? { numerator: quantityValue(r.numerator) } : {}),
        ...(r.denominator ? { denominator: quantityValue(r.denominator) } : {}),
      },
    };
  }
  if (flag(obj, "isCode")) {
    const c = obj as { code?: unknown; system?: unknown; display?: unknown; version?: unknown };
    return {
      name,
      valueCoding: {
        ...(c.system !== undefined && c.system !== null ? { system: c.system } : {}),
        ...(c.version !== undefined && c.version !== null ? { version: c.version } : {}),
        code: c.code,
        ...(c.display !== undefined && c.display !== null ? { display: c.display } : {}),
      },
    };
  }
  if (flag(obj, "isConcept")) {
    const c = obj as { codes?: unknown[]; display?: unknown };
    return {
      name,
      valueCodeableConcept: {
        coding: (c.codes ?? []).map((code) => {
          const cc = code as { code?: unknown; system?: unknown; display?: unknown; version?: unknown };
          return {
            ...(cc.system !== undefined && cc.system !== null ? { system: cc.system } : {}),
            ...(cc.version !== undefined && cc.version !== null ? { version: cc.version } : {}),
            code: cc.code,
            ...(cc.display !== undefined && cc.display !== null ? { display: cc.display } : {}),
          };
        }),
        ...(c.display !== undefined && c.display !== null ? { text: c.display } : {}),
      },
    };
  }
  if ("lowClosed" in obj || "highClosed" in obj || flag(obj, "isInterval")) {
    return intervalParam(name, obj as unknown as IntervalLike);
  }

  // A class instance none of the flags claim — serialize its fields as a tuple rather than losing
  // it. (The empty-tuple encoding above is reachable only through this fallback in principle:
  // `Tuple {}` is a CQL syntax error, so real pipelines cannot produce an empty plain object.)
  const entries = Object.entries(obj);
  if (entries.length === 0) return emptyTupleParam(name);
  return { name, part: entries.flatMap(([field, fieldValue]) => valueToParams(field, fieldValue)) };
}

/** A list ELEMENT that is itself a list nests under parts named `element` (the reader's convention). */
function elementParams(name: string, element: unknown): FhirParameter[] {
  if (Array.isArray(element)) {
    if (element.length === 0) return [emptyListParam(name)];
    return [{ name, part: element.flatMap((e) => elementParams("element", e)) }];
  }
  return valueToParams(name, element);
}

function valueToParams(name: string, value: unknown): FhirParameter[] {
  if (value === null || value === undefined) return [nullParam(name)];
  if (Array.isArray(value)) {
    if (value.length === 0) return [emptyListParam(name)];
    return value.flatMap((element) => elementParams(name, element));
  }
  return [scalarParam(name, value)];
}

/** The whole `$cql` success response: the evaluated value under the standard `return` parameter. */
export function resultToParameters(value: unknown): FhirParameters {
  return { resourceType: "Parameters", parameter: valueToParams("return", value) };
}

/**
 * The runtime-error response body. Emitted with HTTP 200 — the convention the runner codifies
 * (`responseIndicatesError`): a `$cql` evaluation error is a `Parameters` carrying an
 * `evaluation error` parameter whose resource is an OperationOutcome, not a transport failure.
 */
export function evaluationErrorParameters(message: string): FhirParameters {
  return {
    resourceType: "Parameters",
    parameter: [
      {
        name: "evaluation error",
        resource: {
          resourceType: "OperationOutcome",
          issue: [{ severity: "error", code: "exception", diagnostics: message }],
        },
      },
    ],
  };
}
