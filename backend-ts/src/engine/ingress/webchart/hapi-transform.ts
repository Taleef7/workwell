/**
 * Collection→transaction Bundle transform for loading the committed WebChart dev-DB fixtures
 * (`spike/webchart/devdb-patients.json`) into a local HAPI FHIR R4 server — the Doug-suggested
 * "fake WebChart" simulator (ADR-032). Pure and I/O-free so it is unit-testable in CI; the
 * `scripts/load-hapi-fixtures.ts` CLI is the thin fs+fetch wrapper.
 *
 * Two constraints drive the shape:
 * - **PUT, never POST.** The enrollment roster keys on the fixture patient ids (`wc-5`), so a
 *   server-assigned id would silently break roster stamping and every outcome would read
 *   MISSING_DATA. `PUT {type}/{id}` preserves ids and makes re-loads idempotent updates.
 * - **Deterministic minted ids.** The fixtures' clinical resources carry no `id` at all; minting
 *   `{patientId}-{type}-{ordinal}` (ordinal = position within that type in the source bundle)
 *   keeps a re-run updating-in-place instead of duplicating — duplicated Immunizations would
 *   double-count doses and corrupt series-completion outcomes.
 */

type Json = Record<string, unknown>;

export interface TransactionEntry {
  readonly fullUrl: string;
  readonly resource: Json;
  readonly request: { readonly method: "PUT"; readonly url: string };
}

export interface TransactionBundle {
  readonly resourceType: "Bundle";
  readonly type: "transaction";
  readonly entry: readonly TransactionEntry[];
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** FHIR `id` charset: `[A-Za-z0-9\-\.]{1,64}`. Minted ids must satisfy it or the PUT 400s. */
const FHIR_ID_RE = /^[A-Za-z0-9\-.]{1,64}$/;

/**
 * Transform one fixture collection Bundle (exactly one Patient + its id-less clinical resources)
 * into a FHIR transaction Bundle of PUTs. Throws on a bundle without an id-carrying Patient —
 * such a bundle cannot be keyed and must fail loudly rather than load unmatchable data.
 */
export function toTransactionBundle(collection: unknown): TransactionBundle {
  if (!isObject(collection) || collection.resourceType !== "Bundle" || !Array.isArray(collection.entry)) {
    throw new Error("expected a FHIR Bundle with entries");
  }
  const resources: Json[] = [];
  for (const entry of collection.entry) {
    const resource = isObject(entry) ? entry.resource : undefined;
    if (!isObject(resource) || typeof resource.resourceType !== "string") {
      throw new Error("bundle entry without a typed resource");
    }
    resources.push(resource);
  }
  const patient = resources.find((r) => r.resourceType === "Patient");
  if (!patient || typeof patient.id !== "string" || !FHIR_ID_RE.test(patient.id)) {
    throw new Error("bundle has no Patient with a valid id — cannot key its resources");
  }
  const patientId = patient.id;

  const ordinals = new Map<string, number>();
  const entries: TransactionEntry[] = resources.map((resource) => {
    const type = resource.resourceType as string;
    const ordinal = (ordinals.get(type) ?? 0) + 1;
    ordinals.set(type, ordinal);
    const id = typeof resource.id === "string" && resource.id.length > 0
      ? resource.id
      : `${patientId}-${type.toLowerCase()}-${ordinal}`;
    if (!FHIR_ID_RE.test(id)) throw new Error(`minted/source id is not a valid FHIR id: ${id}`);
    const url = `${type}/${id}`;
    return { fullUrl: url, resource: { ...resource, id }, request: { method: "PUT", url } };
  });

  return { resourceType: "Bundle", type: "transaction", entry: entries };
}

/** Transform the whole fixture file (an array of collection Bundles). */
export function toTransactionBundles(collections: unknown): TransactionBundle[] {
  if (!Array.isArray(collections)) throw new Error("expected an array of FHIR Bundles");
  return collections.map((c) => toTransactionBundle(c));
}
