/**
 * CLI: import real VSAC value-set expansions into `value_sets` (E14). For each target OID: `$expand`
 * via VSAC → `upsertResolvedValueSet` (source="VSAC", real codes, RESOLVED), audited VALUE_SETS_RESOLVED.
 * A failed expand writes an ERROR row and continues. Owner-run ON DEMAND, NOT on deploy. Local (SQLite
 * floor) or Neon (export DATABASE_URL + WORKWELL_VSAC_API_KEY). Default target = the CMS122 reference set.
 *
 *   pnpm resolve-valuesets [--oid <oid> ...] [--measure cms122]
 *
 * ROLLBACK (reversible; schema-qualify on Postgres): DELETE FROM workwell_spike.value_sets WHERE source = 'VSAC';
 *
 * Side-effect-free + importable by tests; resolve-valuesets-bin.ts is the runnable entry.
 */
import { getStores, type StoresEnv } from "../../stores/factory.ts";
import { httpVsacClient, type VsacClient } from "../../engine/cql/vsac-client.ts";
import { CMS122V14 } from "../../standards/references/cms122v14.ts";
import type { CaseEventStore } from "../../stores/case-event-store.ts";
import type { ValueSetStore } from "../../stores/value-set-store.ts";

export const USAGE =
  "Usage: pnpm resolve-valuesets [--oid <oid> ...] [--measure cms122] [--manifest <canonical> | --expansion <name>]";
export const DEFAULT_OIDS: string[] = [...new Set(CMS122V14.valueSets.map((v) => v.oid))];
const NAME_BY_OID: Record<string, string> = Object.fromEntries(CMS122V14.valueSets.map((v) => [v.oid, v.name]));

export class ResolveCliUsageError extends Error {
  override readonly name = "ResolveCliUsageError";
}

export interface ResolveArgs {
  oids?: string[];
  /** Release pin (#295) — forwarded to $expand; mutually exclusive. */
  manifest?: string;
  expansion?: string;
}

export function parseArgs(args: string[]): ResolveArgs {
  const oids: string[] = [];
  let manifest: string | undefined;
  let expansion: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--oid") {
      const v = args[++i];
      if (!v) throw new ResolveCliUsageError(`--oid needs a value\n${USAGE}`);
      oids.push(v);
    } else if (a === "--measure") {
      const m = args[++i];
      if (m !== "cms122") throw new ResolveCliUsageError(`--measure only supports 'cms122' today\n${USAGE}`);
      // cms122 → the default set; leave `oids` as-is (default applied by caller).
    } else if (a === "--manifest") {
      const v = args[++i];
      if (!v) throw new ResolveCliUsageError(`--manifest needs a value\n${USAGE}`);
      manifest = v;
    } else if (a === "--expansion") {
      const v = args[++i];
      if (!v) throw new ResolveCliUsageError(`--expansion needs a value\n${USAGE}`);
      expansion = v;
    } else if (a === "--help" || a === "-h") {
      throw new ResolveCliUsageError(USAGE);
    } else {
      throw new ResolveCliUsageError(`unknown argument '${a}'\n${USAGE}`);
    }
  }
  if (manifest && expansion)
    throw new ResolveCliUsageError(`--manifest and --expansion are mutually exclusive\n${USAGE}`);
  return {
    ...(oids.length ? { oids } : {}),
    ...(manifest ? { manifest } : {}),
    ...(expansion ? { expansion } : {}),
  };
}

export interface RunResolveDeps {
  oids: string[];
  client: VsacClient;
  valueSets: ValueSetStore;
  events: CaseEventStore;
  now: string;
  /** Release pin (#295) — forwarded to every $expand. */
  manifest?: string;
  expansion?: string;
}

export interface ResolveResult {
  resolved: number;
  errors: number;
  /** OIDs whose expansion hash changed vs the previously imported row (#295 drift detection). */
  changed: string[];
}

/**
 * Expansion hash: SHA-256 over the sorted `system|code` pairs PLUS the expansion's version
 * provenance (#295). Version fields are included because the same member set published under a
 * new ValueSet.version is a different expansion for reproducibility purposes. Prefixed `sha256:`
 * so the older 32-bit rolling hashes (`h<hex>`) are distinguishable in existing rows rather than
 * silently compared against a different algorithm.
 */
const HASH_PREFIX = "sha256:";

async function expansionHash(
  codes: { code: string; system: string }[],
  provenance: { version?: string },
): Promise<string> {
  // Deliberately NOT hashed: `expansion.identifier`. FHIR R4 does not require a server to reuse the
  // same identifier for an unchanged expansion (fhir-modelinfo-4.0.1.xml `ValueSet.expansion.identifier`),
  // so VSAC returning a fresh one for identical content would fire a false VALUE_SET_EXPANSION_CHANGED.
  // The stable drift signal is the member set + ValueSet.version; the identifier is audit provenance only.
  const joined = codes
    .map((c) => `${c.system}|${c.code}`)
    .sort()
    .join(",");
  const payload = `v=${provenance.version ?? ""};${joined}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${HASH_PREFIX}${hex}`;
}

export async function runResolve(deps: RunResolveDeps): Promise<ResolveResult> {
  let resolved = 0;
  let errors = 0;
  const changed: string[] = [];
  const pin =
    deps.manifest || deps.expansion
      ? { ...(deps.manifest ? { manifest: deps.manifest } : {}), ...(deps.expansion ? { expansion: deps.expansion } : {}) }
      : undefined;
  // Prior hashes for drift detection (#295). One bounded read of the catalog (dozens of rows on an
  // offline CLI) rather than a new per-OID store method.
  // Only SHA-256 hashes are comparable: pre-#295 rows hold a 32-bit rolling hash (`h<hex>`), and
  // comparing across algorithms would report drift for every legacy row on the first import after
  // this change — a false alarm that would teach the operator to ignore the signal.
  const priorHash = new Map<string, string>();
  for (const row of await deps.valueSets.listAll()) {
    if (row.expansionHash?.startsWith(HASH_PREFIX)) priorHash.set(row.oid, row.expansionHash);
  }
  for (const oid of deps.oids) {
    try {
      const exp = await deps.client.expand(oid, pin);
      const codes = exp.contains.map((c) => ({ code: c.code, display: c.display ?? c.code, system: c.system }));
      const hash = await expansionHash(codes, exp);
      const before = priorHash.get(oid);
      const drifted = before !== undefined && before !== hash;
      await deps.valueSets.upsertResolvedValueSet({
        oid,
        name: NAME_BY_OID[oid] ?? oid,
        version: exp.version ?? null,
        source: "VSAC",
        codes,
        resolutionStatus: "RESOLVED",
        resolutionError: null,
        expansionHash: hash,
        lastResolvedAt: deps.now,
      });
      await deps.events.appendAudit({
        eventType: "VALUE_SETS_RESOLVED",
        entityType: "value_set",
        entityId: oid,
        actor: "resolve-valuesets",
        refRunId: null,
        refCaseId: null,
        refMeasureVersionId: null,
        payload: {
          oid,
          codes: codes.length,
          source: "VSAC",
          status: "RESOLVED",
          version: exp.version ?? null,
          expansionIdentifier: exp.expansionIdentifier ?? null,
          expansionTimestamp: exp.expansionTimestamp ?? null,
          expansionHash: hash,
          ...(deps.manifest ? { manifest: deps.manifest } : {}),
          ...(deps.expansion ? { expansion: deps.expansion } : {}),
        },
      });
      if (drifted) {
        // A republish changed an expansion we had already imported — the ADR-008 silent-drift case.
        // Distinct event so it is greppable/alertable, not buried in a routine resolve.
        changed.push(oid);
        await deps.events.appendAudit({
          eventType: "VALUE_SET_EXPANSION_CHANGED",
          entityType: "value_set",
          entityId: oid,
          actor: "resolve-valuesets",
          refRunId: null,
          refCaseId: null,
          refMeasureVersionId: null,
          payload: {
            oid,
            previousExpansionHash: before,
            expansionHash: hash,
            codes: codes.length,
            version: exp.version ?? null,
            ...(deps.manifest ? { manifest: deps.manifest } : {}),
            ...(deps.expansion ? { expansion: deps.expansion } : {}),
          },
        });
      }
      resolved++;
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      // Preserve the last-good comparable hash across a transient failure. The upsert adapters
      // overwrite expansion_hash unconditionally (value-set-store-{sqlite,postgres}), so writing
      // null here would erase the drift baseline — then a later success→failure→changed-success
      // sequence would silently miss the drift. The ERROR row's codes are empty and its
      // resolution_status flags it, so retaining the prior hash as a baseline is sound.
      await deps.valueSets.upsertResolvedValueSet({
        oid,
        name: NAME_BY_OID[oid] ?? oid,
        version: null,
        source: "VSAC",
        codes: [],
        resolutionStatus: "ERROR",
        resolutionError: message,
        expansionHash: priorHash.get(oid) ?? null,
        lastResolvedAt: deps.now,
      });
      await deps.events.appendAudit({
        eventType: "VALUE_SETS_RESOLVED",
        entityType: "value_set",
        entityId: oid,
        actor: "resolve-valuesets",
        refRunId: null,
        refCaseId: null,
        refMeasureVersionId: null,
        payload: { oid, source: "VSAC", status: "ERROR", error: message },
      });
      errors++;
    }
  }
  return { resolved, errors, changed };
}

/** Build the store env from `process.env` — the same selection the worker factory makes (DATABASE_URL
 *  → Postgres ceiling, no local SQLite; otherwise a local SQLite floor file). Mirrors seed-scale.ts. */
async function buildEnv(): Promise<StoresEnv> {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (databaseUrl) return { DATABASE_URL: databaseUrl };
  // @ts-expect-error — @mieweb/cloud-local ships .mjs without types
  const { createSqliteD1 } = await import("@mieweb/cloud-local");
  const dbPath = process.env.WORKWELL_SQLITE_PATH ?? "./.workwell-local.sqlite";
  const DB = await createSqliteD1(dbPath);
  return { DB };
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ResolveArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (e instanceof ResolveCliUsageError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
  const apiKey = (process.env.WORKWELL_VSAC_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("WORKWELL_VSAC_API_KEY is required to resolve value sets against VSAC.");
    return 2;
  }
  const baseUrl = (process.env.WORKWELL_VSAC_BASE_URL ?? "").trim() || "https://cts.nlm.nih.gov/fhir";
  const oids = parsed.oids ?? DEFAULT_OIDS;
  const env = await buildEnv();
  const stores = await getStores(env);
  if (!parsed.manifest && !parsed.expansion) {
    console.warn(
      "resolve-valuesets: no --manifest/--expansion pin — VSAC will serve LATEST-ACTIVE expansions, " +
        "so this import is not reproducible (#295). Pass --manifest <canonical> to pin a release.",
    );
  }
  const res = await runResolve({
    oids,
    client: httpVsacClient({ baseUrl, apiKey }),
    valueSets: stores.valueSets,
    events: stores.events,
    now: new Date().toISOString(),
    ...(parsed.manifest ? { manifest: parsed.manifest } : {}),
    ...(parsed.expansion ? { expansion: parsed.expansion } : {}),
  });
  console.log(`resolve-valuesets: ${res.resolved} resolved, ${res.errors} error(s), ${oids.length} target(s).`);
  if (res.changed.length) {
    console.warn(
      `resolve-valuesets: ${res.changed.length} expansion(s) CHANGED since the last import ` +
        `(VALUE_SET_EXPANSION_CHANGED audited): ${res.changed.join(", ")}`,
    );
  }
  return res.errors > 0 && res.resolved === 0 ? 1 : 0;
}
