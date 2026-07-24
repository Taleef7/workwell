/**
 * Canonical hashing of an evaluated FHIR bundle — the `data_hash` change signal for incremental
 * evaluation (#263, Phase 2a). Descriptive only (ADR-008): the hash decides *whether* to re-run CQL,
 * never what a status is.
 *
 * The hash is taken over the **normalized, evaluated** bundle — i.e. the exact object the engine
 * receives (`deps.engine.evaluate({ patientBundle })` in `run-pipeline.ts`), AFTER WebChart
 * normalization + enrollment stamping — so any change to what CQL actually sees moves the hash, and
 * WorkWell-side inputs (enrollment, segments-driven stamping) are captured by construction (design §2).
 *
 * Canonicalization is mandatory (design §5): `JSON.stringify` over a FHIR bundle is key-order-dependent,
 * so a server that reorders fields would false-invalidate every entry. We recursively sort object keys,
 * sort the top-level `Bundle.entry` list by `resource.resourceType`/`resource.id` (the one array whose
 * order carries no clinical meaning), and strip a small, documented set of volatile server-assigned
 * fields the CQL provably cannot read. Every other array keeps its order (FHIR arrays are otherwise
 * order-significant — e.g. `Observation.component`), so a real reorder there still moves the hash.
 *
 * WebCrypto SHA-256 (`crypto.subtle.digest`) — the portable pattern already used by
 * `mcp/tool-audit.ts` / `audit/audit-packet.ts` (Node + Workers; no `node:crypto`, no new dep). Output
 * is the house `sha256:<hex>` format (`case-event-store.ts`).
 */

/**
 * Recursively strip only `meta.lastUpdated` / `meta.versionId` — server modification metadata invisible
 * to CQL, volatile on ANY resource (nested or contained), so stripping it at any depth is correct.
 * Everything else is preserved so a real change stays visible (design §5). `Bundle.timestamp` and
 * `entry[].fullUrl` are handled level-scoped by `canonicalizeForHash` below, NOT here — stripping a field
 * merely NAMED `timestamp`/`fullUrl` at arbitrary depth could hide a real change if a future measure ever
 * read such an element (review #4).
 */
const stripMeta = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripMeta);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "meta" && v !== null && typeof v === "object" && !Array.isArray(v)) {
      const meta: Record<string, unknown> = {};
      for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
        if (mk === "lastUpdated" || mk === "versionId") continue;
        meta[mk] = stripMeta(mv);
      }
      // Drop an emptied `meta` entirely so `{meta:{}}` and absent-meta canonicalize identically.
      if (Object.keys(meta).length > 0) out[k] = meta;
      continue;
    }
    out[k] = stripMeta(v);
  }
  return out;
};

/**
 * Level-scoped strip of the two transport-wrapper fields, applied only where FHIR actually places them:
 * `Bundle.timestamp` at the Bundle root, and `fullUrl` on each `Bundle.entry`. A non-Bundle input (a bare
 * resource) is returned meta-stripped only.
 */
const stripVolatile = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return stripMeta(value);
  const obj = value as Record<string, unknown>;
  if (obj.resourceType !== "Bundle") return stripMeta(value);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "timestamp") continue; // Bundle.timestamp — assembly time, not clinical content
    if (k === "entry" && Array.isArray(v)) {
      out[k] = v.map((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return stripMeta(entry);
        const e: Record<string, unknown> = {};
        for (const [ek, ev] of Object.entries(entry as Record<string, unknown>)) {
          if (ek === "fullUrl") continue; // entry.fullUrl — server-assigned wrapper; resource.id is kept
          e[ek] = stripMeta(ev);
        }
        return e;
      });
      continue;
    }
    out[k] = stripMeta(v);
  }
  return out;
};

/** Stable ordering key for a bundle entry — `resourceType/id`, matching the design's sort spec. */
const entrySortKey = (entry: unknown): string => {
  const r = (entry as { resource?: { resourceType?: unknown; id?: unknown } } | null)?.resource;
  const type = typeof r?.resourceType === "string" ? r.resourceType : "";
  const id = typeof r?.id === "string" ? r.id : "";
  return `${type}/${id}`;
};

/**
 * Deterministic string form of a value: object keys sorted recursively, arrays kept in order (they are
 * order-significant in FHIR), EXCEPT a `Bundle.entry` list — which is sorted by `resourceType/id` first,
 * since entry order carries no clinical meaning and servers may reorder it.
 */
const canonicalString = (value: unknown, key?: string): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = key === "entry" ? [...value].sort((a, b) => entrySortKey(a).localeCompare(entrySortKey(b))) : value;
    return `[${items.map((v) => canonicalString(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalString(v, k)}`).join(",")}}`;
};

/** The canonical, volatile-stripped string form of a bundle — exposed for golden tests. */
export function canonicalizeForHash(bundle: unknown): string {
  return canonicalString(stripVolatile(bundle));
}

/**
 * `sha256:<hex>` of the canonicalized evaluated bundle. A *material* clinical edit (a new/changed
 * Observation, a changed date or code, an added enrollment Condition) always moves this; volatile
 * server metadata and object-key reordering never do.
 */
export async function hashBundle(bundle: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeForHash(bundle));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
