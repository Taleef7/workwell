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
 * resource) so a first-cut against the real API doesn't hard-fail on an unexpected envelope. No I/O,
 * no new deps (the transport lives in `webchart-client.ts`), and it does NOT mutate the input — it
 * builds new resource objects. Descriptive only (ADR-008).
 */
import type { FhirBundle } from "../../synthetic/fhir-bundle-builder.ts";
import { reconcileCodings, targetEventType, type Coding } from "./terminology.ts";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pull the resource list out of whatever envelope the API returned. */
function extractResources(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw.flatMap(extractResources);
  if (!isObject(raw)) return [];
  // A FHIR Bundle: entry[].resource. A Bundle with no entry array yields nothing (it must NOT fall
  // through to the bare-resource branch and wrap the Bundle itself). Entries without a `.resource`
  // (e.g. a searchset entry with only fullUrl/search) are dropped, not leaked as bogus resources.
  if (raw.resourceType === "Bundle") {
    return Array.isArray(raw.entry)
      ? raw.entry.map((e) => (isObject(e) ? e.resource : undefined)).filter((r) => isObject(r))
      : [];
  }
  // A bare resource
  if (typeof raw.resourceType === "string") return [raw];
  return [];
}

/** A NEW coding-holder with reconciled codings, or the original reference if nothing changed. */
function reconciledHolder(holder: unknown): { holder: unknown; codings: Coding[] } {
  if (!isObject(holder) || !Array.isArray(holder.coding)) return { holder, codings: [] };
  const codings = reconcileCodings(holder.coding as Coding[]);
  if (codings === holder.coding) return { holder, codings }; // no-op — same reference
  return { holder: { ...holder, coding: codings }, codings };
}

// Only clinically-final events drive compliance. A cancelled/errored WebChart event — a `not-done` or
// `entered-in-error` Procedure/Immunization, a `preliminary`/`registered`/`cancelled`/`entered-in-error`
// Observation — must NOT be reconciled to a measure coding or synthesized into a `completed` Procedure, or
// the recency CQL (which matches only code + date, not status) would count it as compliant (Codex P2).
// A missing status is treated as non-final (conservative; the line-130 test guards it).
const FINAL_STATUS: Record<string, ReadonlySet<string>> = {
  Procedure: new Set(["completed"]),
  Immunization: new Set(["completed"]),
  Observation: new Set(["final", "amended", "corrected"]),
};

// BP panel LOINCs. teatea (verified 2026-07-23) exports the blood-pressure PANEL with status `unknown`
// (systolic/diastolic in component[], no top-level value) — `unknown` = FHIR "source doesn't know the
// workflow status", NOT an invalidity marker. We accept `unknown` ONLY for this verified shape.
const BP_PANEL_LOINC = new Set(["85354-9", "55284-4"]);

function isBpPanel(resource: Json): boolean {
  const code = resource.code;
  if (!isObject(code) || !Array.isArray(code.coding)) return false;
  return code.coding.some(
    (c) =>
      isObject(c) &&
      typeof c.code === "string" &&
      BP_PANEL_LOINC.has(c.code) &&
      (typeof c.system !== "string" || /loinc/i.test(c.system)),
  );
}

function isFinalEvent(resource: Json): boolean {
  const allowed = FINAL_STATUS[resource.resourceType as string];
  if (!allowed) return true; // non-event resources aren't status-gated (their codings don't reconcile anyway)
  const status = typeof resource.status === "string" ? resource.status : undefined;
  if (status && allowed.has(status)) return true;
  // Narrow exception: a BP PANEL with status `unknown` IS final (real WebChart BP shape). Scoped to the
  // verified BP shape so an unknown-status LAB (HbA1c/LDL) — where `unknown` could mean an unverified
  // result — can never synthesize a completed Procedure and read as compliant (AGENTS.md: never falsely
  // compliant; Codex P1 #328).
  return status === "unknown" && resource.resourceType === "Observation" && isBpPanel(resource);
}

/** The best effective instant for a lab Observation → a synthesized Procedure's `performedDateTime`. */
function observationEffective(obs: Json): string | undefined {
  if (typeof obs.effectiveDateTime === "string") return obs.effectiveDateTime;
  const period = obs.effectivePeriod;
  if (isObject(period) && typeof period.start === "string") return period.start;
  if (typeof obs.issued === "string") return obs.issued;
  return undefined;
}

/**
 * Reconcile one WebChart resource → one or more engine resources (a NEW array; the input is never
 * mutated). Appends the synthetic event coding to `code`/`vaccineCode`. Additionally, when a lab
 * `Observation` reconciles to a measure whose CQL retrieves `[Procedure]` (the recency lab/vital
 * measures — WebChart records the lab as an Observation, the measure looks for a Procedure), a dated
 * `Procedure` carrying that target coding is synthesized so the measure can match. `cms122` retrieves
 * `[Observation]`, so its coding stays on the Observation. Provenance: the real coding is preserved,
 * and a synthesized Procedure is tagged `derived-from-observation`.
 *
 * Non-final events (see `isFinalEvent`) pass through untouched — no measure coding is appended and no
 * Procedure is synthesized — so a cancelled/errored WebChart event can never read as compliant.
 */
function reconcileResource(resource: unknown): unknown[] {
  if (!isObject(resource)) return [];
  if (!isFinalEvent(resource)) return [resource]; // don't reconcile a non-final / errored clinical event
  const code = reconciledHolder(resource.code);
  const vaccineCode = reconciledHolder(resource.vaccineCode);
  const out: Json = { ...resource };
  if (code.holder !== resource.code) out.code = code.holder;
  if (vaccineCode.holder !== resource.vaccineCode) out.vaccineCode = vaccineCode.holder;
  const results: unknown[] = [out];

  if (resource.resourceType === "Observation") {
    const when = observationEffective(resource);
    const seen = new Set<string>();
    for (const target of code.codings) {
      const key = `${target.system}|${target.code}`;
      if (targetEventType(target) === "procedure" && !seen.has(key)) {
        seen.add(key);
        results.push({
          resourceType: "Procedure",
          status: "completed",
          meta: { tag: [{ system: "urn:workwell:webchart", code: "derived-from-observation" }] },
          ...(isObject(resource.subject) ? { subject: resource.subject } : {}),
          code: { coding: [target] },
          ...(when ? { performedDateTime: when } : {}),
        });
      }
    }
  }
  return results;
}

/**
 * Normalize one patient's WebChart API payload into the engine's `Bundle` (type `collection`),
 * reconciling terminology on the way. An empty/garbage payload yields an empty bundle (the engine
 * then evaluates it as MISSING_DATA), never a throw — per-patient error isolation stays with the
 * caller (`evaluateBatch`).
 */
export function normalizeWebChartBundle(raw: unknown): FhirBundle {
  const entries = extractResources(raw)
    .flatMap((r) => reconcileResource(r))
    .map((resource) => ({ resource }));
  return { resourceType: "Bundle", type: "collection", entry: entries };
}
