/**
 * WebChart FHIR bundle normalization (E12 PR-2).
 *
 * The chosen integration path is WebChart's HTTP/FHIR API (ADR decision 2026-07-03; details firming
 * up with Dave Carlson). This module coerces whatever the API yields per patient into the exact
 * `Bundle` (type `collection`) shape the unchanged `CqlExecutionEngine` consumes (mirrors
 * `engine/synthetic/fhir-bundle-builder.ts`), and applies the terminology reconciliation so real
 * LOINC/CVX/CPT codings gain the synthetic measure-event coding the CQL inline filters match.
 *
 * Robust to shape drift (a FHIR searchset/collection Bundle, a bare resource array, or a single
 * resource) so a first-cut against the real API doesn't hard-fail on an unexpected envelope. Pure —
 * no I/O, no new deps; the transport lives in `webchart-client.ts`. Descriptive only (ADR-008).
 */
import type { FhirBundle } from "../../synthetic/fhir-bundle-builder.ts";
import { reconcileCodings, type Coding } from "./terminology.ts";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pull the resource list out of whatever envelope the API returned. */
function extractResources(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw.flatMap(extractResources);
  if (!isObject(raw)) return [];
  // A FHIR Bundle: entry[].resource (a Bundle with no entry array yields nothing — it must NOT fall
  // through to the bare-resource branch and wrap the Bundle itself as a resource).
  if (raw.resourceType === "Bundle") {
    return Array.isArray(raw.entry)
      ? raw.entry.map((e) => (isObject(e) ? (e.resource ?? e) : e)).filter((r) => isObject(r))
      : [];
  }
  // A bare resource
  if (typeof raw.resourceType === "string") return [raw];
  return [];
}

/** Reconcile the coding array at `resource[field].coding`, if present, in place. */
function reconcileField(resource: Json, field: "code" | "vaccineCode"): void {
  const holder = resource[field];
  if (!isObject(holder) || !Array.isArray(holder.coding)) return;
  holder.coding = reconcileCodings(holder.coding as Coding[]);
}

/** Add the measure-event synthetic coding to a clinical resource so the CQL inline filter matches. */
function reconcileResource(resource: unknown): unknown {
  if (!isObject(resource)) return resource;
  // Observation/Procedure/Condition carry `code`; Immunization carries `vaccineCode`. Reconcile both
  // generically — a resource without the field is untouched, and non-clinical resources never match.
  reconcileField(resource, "code");
  reconcileField(resource, "vaccineCode");
  return resource;
}

/**
 * Normalize one patient's WebChart API payload into the engine's `Bundle` (type `collection`),
 * reconciling terminology on the way. An empty/garbage payload yields an empty bundle (the engine
 * then evaluates it as MISSING_DATA), never a throw — per-patient error isolation stays with the
 * caller (`evaluateBatch`).
 */
export function normalizeWebChartBundle(raw: unknown): FhirBundle {
  const entries = extractResources(raw).map((r) => ({ resource: reconcileResource(r) }));
  return { resourceType: "Bundle", type: "collection", entry: entries };
}
