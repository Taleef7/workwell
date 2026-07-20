/**
 * Value-set governance (#108) — TS port of ValueSetGovernanceService + the catalog value-set
 * methods of MeasureService (list/create/attach/detach/listByVersion). Resolve-check, diff, and
 * detail back the Studio governance panel + the activation gate; create/attach/detach back the
 * Studio Value Sets tab; listByVersion backs the case-detail + measure-detail linked sets.
 *
 * Compliance is never decided here — these surfaces only describe value-set resolvability and
 * gate activation; the CQL engine remains the sole source of outcomes.
 */
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { MeasureStore } from "../stores/measure-store.ts";
import type {
  CodeEntry,
  TerminologyMappingRecord,
  ValueSetRecord,
  ValueSetStore,
} from "../stores/value-set-store.ts";

export class ValueSetError extends Error {}

export interface ValueSetGovernanceDeps {
  valueSets: ValueSetStore;
  measures: MeasureStore;
  events: Pick<CaseEventStore, "appendAudit">;
}

/** Catalog/linked value-set shape (frontend ValueSetRef). */
export interface ValueSetRef {
  id: string;
  oid: string;
  name: string;
  version: string | null;
  lastResolvedAt: string | null;
  resolvabilityStatus: string;
  resolvabilityLabel: string;
  resolvabilityNote: string;
  codeCount: number;
}

export interface ValueSetCheckItem {
  id: string;
  name: string;
  oid: string;
  version: string | null;
  resolutionStatus: string;
  codeCount: number;
  warnings: string[];
  blocker: boolean;
}

export interface ResolveCheckResult {
  measureId: string;
  measureVersionId: string;
  allResolved: boolean;
  valueSets: ValueSetCheckItem[];
  blockers: string[];
  warnings: string[];
}

export interface ValueSetDiffResponse {
  fromId: string;
  fromName: string;
  fromVersion: string | null;
  toId: string;
  toName: string;
  toVersion: string | null;
  addedCodes: CodeEntry[];
  removedCodes: CodeEntry[];
  affectedMeasures: Array<{ measureId: string; measureName: string; version: string }>;
  warnings: string[];
}

export interface ValueSetDetail {
  id: string;
  oid: string;
  name: string;
  version: string | null;
  lastResolvedAt: string | null;
  canonicalUrl: string;
  source: string;
  governanceStatus: string;
  resolutionStatus: string;
  resolutionError: string;
  expansionHash: string;
  codeCount: number;
  codeSystems: string[];
  codes: CodeEntry[];
}

// ---- catalog list/create/attach/detach --------------------------------------

/** Faithful to MeasureService.listValueSets: the catalog lists every set as UNRESOLVED/0 (no per-set expansion at list time). */
export async function listValueSets(store: ValueSetStore): Promise<ValueSetRef[]> {
  const records = await store.listAll();
  return records.map((vs) => ({
    id: vs.id,
    oid: vs.oid,
    name: vs.name,
    version: vs.version,
    lastResolvedAt: vs.lastResolvedAt,
    resolvabilityStatus: "UNRESOLVED",
    resolvabilityLabel: "Unresolved",
    resolvabilityNote: "Codes not yet loaded. Resolvability check will warn at compile time.",
    codeCount: 0,
  }));
}

/** Linked-to-a-version refs with computed resolvability (MeasureService.listValueSetsByVersionId). */
export async function listValueSetsByVersion(store: ValueSetStore, measureVersionId: string): Promise<ValueSetRef[]> {
  const records = await store.listByVersion(measureVersionId);
  return records.map(toRef);
}

function toRef(vs: ValueSetRecord): ValueSetRef {
  const codeCount = vs.codes.length;
  const demoResolved = vs.oid.startsWith("urn:workwell:vs:");
  const resolved = demoResolved || codeCount > 0;
  return {
    id: vs.id,
    oid: vs.oid,
    name: vs.name,
    version: vs.version,
    lastResolvedAt: vs.lastResolvedAt,
    resolvabilityStatus: resolved ? "RESOLVED" : "UNRESOLVED",
    resolvabilityLabel: demoResolved ? "Resolved (demo)" : codeCount > 0 ? "Resolved" : "Unresolved",
    resolvabilityNote: resolved ? "" : "Codes not yet loaded. Resolvability check will warn at compile time.",
    codeCount,
  };
}

const MAX_CREATE_CODES = 200;

export async function createValueSet(
  store: ValueSetStore,
  oid: string,
  name: string,
  version: string | null,
  codes?: CodeEntry[],
): Promise<string> {
  if (!oid?.trim() || !name?.trim()) throw new ValueSetError("oid and name are required");
  // Optional seed codes (the Studio Codify pick — Codex P1: a picked code must land IN the set,
  // not be discarded). Validated strictly; an empty/absent array keeps the historical empty-set
  // create. Reuses the existing setCodes surface — no schema, no new store method.
  if (codes !== undefined) {
    if (!Array.isArray(codes) || codes.length > MAX_CREATE_CODES) {
      throw new ValueSetError(`codes must be an array of at most ${MAX_CREATE_CODES} entries`);
    }
    for (const c of codes) {
      if (!c || typeof c.code !== "string" || !c.code.trim() || typeof c.system !== "string" || !c.system.trim()) {
        throw new ValueSetError("each code entry requires non-empty string 'code' and 'system' (plus 'display')");
      }
      if (typeof c.display !== "string") throw new ValueSetError("each code entry requires a string 'display'");
    }
  }
  const id = await store.create(oid, name, version);
  if (codes && codes.length > 0) {
    await store.setCodes(
      id,
      codes.map((c) => ({ code: c.code.trim(), display: c.display.trim(), system: c.system.trim() })),
    );
  }
  return id;
}

export async function attachValueSet(deps: ValueSetGovernanceDeps, measureId: string, valueSetId: string, actor = "system"): Promise<void> {
  const versionId = await latestVersionId(deps, measureId);
  await deps.valueSets.link(versionId, valueSetId);
  await deps.events.appendAudit(auditLink("MEASURE_VALUE_SET_LINKED", versionId, measureId, valueSetId, actor));
}

export async function detachValueSet(deps: ValueSetGovernanceDeps, measureId: string, valueSetId: string, actor = "system"): Promise<void> {
  const versionId = await latestVersionId(deps, measureId);
  await deps.valueSets.unlink(versionId, valueSetId);
  await deps.events.appendAudit(auditLink("MEASURE_VALUE_SET_UNLINKED", versionId, measureId, valueSetId, actor));
}

function auditLink(eventType: string, versionId: string, measureId: string, valueSetId: string, actor: string) {
  return {
    eventType,
    entityType: "measure_version",
    entityId: versionId,
    actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: versionId,
    payload: { measureId, valueSetId },
  };
}

// ---- resolve-check / diff / detail ------------------------------------------

export async function resolveCheck(deps: ValueSetGovernanceDeps, measureId: string): Promise<ResolveCheckResult> {
  const measure = await deps.measures.getLatest(measureId);
  if (!measure) throw new ValueSetError(`Measure not found: ${measureId}`);
  const cqlText = measure.cqlText ?? "";
  const records = await deps.valueSets.listByVersion(measure.versionId);

  const items: ValueSetCheckItem[] = records.map((vs) => {
    const codeCount = vs.codes.length;
    const warnings: string[] = [];
    let blocker = false;
    if (codeCount === 0) {
      warnings.push("Value set has no codes — activation blocked.");
      blocker = true;
    } else if (["UNRESOLVED", "EMPTY", "ERROR"].includes(vs.resolutionStatus)) {
      warnings.push(`Resolution status is ${vs.resolutionStatus}.`);
      blocker = true;
    }
    if (cqlText.trim() !== "" && !cqlText.includes(`"${vs.name}"`) && !cqlText.includes(`'${vs.name}'`)) {
      warnings.push("Not referenced in CQL text — may be attached but unused.");
    }
    return { id: vs.id, name: vs.name, oid: vs.oid, version: vs.version, resolutionStatus: vs.resolutionStatus, codeCount, warnings, blocker };
  });

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (items.length === 0) warnings.push("No value sets are attached to this measure version.");
  for (const item of items) {
    for (const w of item.warnings) {
      if (item.blocker && !w.startsWith("Not referenced")) blockers.push(`[${item.name}] ${w}`);
      else warnings.push(`[${item.name}] ${w}`);
    }
  }
  checkCqlUnattachedReferences(cqlText, items, blockers);

  return { measureId, measureVersionId: measure.versionId, allResolved: blockers.length === 0, valueSets: items, blockers, warnings };
}

function checkCqlUnattachedReferences(cqlText: string, attached: ValueSetCheckItem[], blockers: string[]): void {
  if (!cqlText || cqlText.trim() === "") return;
  const attachedNames = new Set(attached.map((i) => i.name));
  for (const line of cqlText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("valueset ")) {
      const name = extractValueSetName(trimmed);
      if (name && !attachedNames.has(name)) blockers.push(`CQL references value set "${name}" which is not attached.`);
    }
  }
}

function extractValueSetName(cqlLine: string): string | null {
  const start = cqlLine.indexOf('"');
  if (start < 0) return null;
  const end = cqlLine.indexOf('"', start + 1);
  if (end < 0) return null;
  return cqlLine.substring(start + 1, end);
}

export async function diffValueSets(store: ValueSetStore, fromId: string, toId: string): Promise<ValueSetDiffResponse> {
  const from = await store.getById(fromId);
  if (!from) throw new ValueSetError(`Value set not found: ${fromId}`);
  const to = await store.getById(toId);
  if (!to) throw new ValueSetError(`Value set not found: ${toId}`);

  const key = (c: CodeEntry) => `${c.system}|${c.code}`;
  const fromKeys = new Set(from.codes.map(key));
  const toKeys = new Set(to.codes.map(key));
  const addedCodes = to.codes.filter((c) => !fromKeys.has(key(c)));
  const removedCodes = from.codes.filter((c) => !toKeys.has(key(c)));

  const affectedMeasures = await store.affectedMeasures([...new Set([fromId, toId])]);
  const warnings: string[] = [];
  if (addedCodes.length > 0) warnings.push(`${addedCodes.length} code(s) added.`);
  if (removedCodes.length > 0) warnings.push(`${removedCodes.length} code(s) removed — existing CQL evaluations may be affected.`);

  return {
    fromId: from.id,
    fromName: from.name,
    fromVersion: from.version,
    toId: to.id,
    toName: to.name,
    toVersion: to.version,
    addedCodes,
    removedCodes,
    affectedMeasures,
    warnings,
  };
}

export async function getValueSetDetail(store: ValueSetStore, id: string): Promise<ValueSetDetail> {
  const vs = await store.getById(id);
  if (!vs) throw new ValueSetError(`Value set not found: ${id}`);
  return {
    id: vs.id,
    oid: vs.oid,
    name: vs.name,
    version: vs.version,
    lastResolvedAt: vs.lastResolvedAt,
    canonicalUrl: vs.canonicalUrl,
    source: vs.source,
    governanceStatus: vs.governanceStatus,
    resolutionStatus: vs.resolutionStatus,
    resolutionError: vs.resolutionError,
    expansionHash: vs.expansionHash,
    codeCount: vs.codes.length,
    codeSystems: vs.codeSystems,
    codes: vs.codes,
  };
}

async function latestVersionId(deps: ValueSetGovernanceDeps, measureId: string): Promise<string> {
  const measure = await deps.measures.getLatest(measureId);
  if (!measure) throw new ValueSetError(`Measure not found: ${measureId}`);
  return measure.versionId;
}

// ---- terminology mappings (Admin → Terminology Mappings) --------------------

export interface CreateTerminologyMappingRequest {
  localCode: string;
  localDisplay: string | null;
  localSystem: string;
  standardCode: string;
  standardDisplay: string | null;
  standardSystem: string;
  mappingStatus: string | null;
  mappingConfidence: number | null;
  notes: string | null;
}

export async function listTerminologyMappings(store: ValueSetStore): Promise<TerminologyMappingRecord[]> {
  return store.listTerminologyMappings();
}

export async function createTerminologyMapping(
  deps: Pick<ValueSetGovernanceDeps, "valueSets" | "events">,
  req: CreateTerminologyMappingRequest,
  actor: string,
): Promise<TerminologyMappingRecord> {
  if (!req.localCode?.trim() || !req.localSystem?.trim() || !req.standardCode?.trim() || !req.standardSystem?.trim()) {
    throw new ValueSetError("localCode, localSystem, standardCode, and standardSystem are required");
  }
  const id = crypto.randomUUID();
  const mappingStatus = req.mappingStatus ?? "PROPOSED";
  const record = await deps.valueSets.createTerminologyMapping({
    id,
    localCode: req.localCode,
    localDisplay: req.localDisplay,
    localSystem: req.localSystem,
    standardCode: req.standardCode,
    standardDisplay: req.standardDisplay,
    standardSystem: req.standardSystem,
    mappingStatus,
    mappingConfidence: req.mappingConfidence,
    notes: req.notes,
  });
  await deps.events.appendAudit({
    eventType: "TERMINOLOGY_MAPPING_CREATED",
    entityType: "terminology_mapping",
    entityId: id,
    actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: {
      mappingId: id,
      localCode: req.localCode,
      localSystem: req.localSystem,
      standardCode: req.standardCode,
      standardSystem: req.standardSystem,
      mappingStatus,
      mappingConfidence: req.mappingConfidence,
    },
  });
  return record;
}
