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

export const USAGE = "Usage: pnpm resolve-valuesets [--oid <oid> ...] [--measure cms122]";
export const DEFAULT_OIDS: string[] = [...new Set(CMS122V14.valueSets.map((v) => v.oid))];
const NAME_BY_OID: Record<string, string> = Object.fromEntries(CMS122V14.valueSets.map((v) => [v.oid, v.name]));

export class ResolveCliUsageError extends Error {
  override readonly name = "ResolveCliUsageError";
}

export interface ResolveArgs {
  oids?: string[];
}

export function parseArgs(args: string[]): ResolveArgs {
  const oids: string[] = [];
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
    } else if (a === "--help" || a === "-h") {
      throw new ResolveCliUsageError(USAGE);
    } else {
      throw new ResolveCliUsageError(`unknown argument '${a}'\n${USAGE}`);
    }
  }
  return oids.length ? { oids } : {};
}

export interface RunResolveDeps {
  oids: string[];
  client: VsacClient;
  valueSets: ValueSetStore;
  events: CaseEventStore;
  now: string;
}

export interface ResolveResult {
  resolved: number;
  errors: number;
}

/** Simple, deterministic expansion hash over sorted code|system pairs (idempotency/audit only). */
function expansionHash(codes: { code: string; system: string }[]): string {
  const joined = codes
    .map((c) => `${c.system}|${c.code}`)
    .sort()
    .join(",");
  let h = 0;
  for (const ch of joined) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `h${h.toString(16)}`;
}

export async function runResolve(deps: RunResolveDeps): Promise<ResolveResult> {
  let resolved = 0;
  let errors = 0;
  for (const oid of deps.oids) {
    try {
      const exp = await deps.client.expand(oid);
      const codes = exp.contains.map((c) => ({ code: c.code, display: c.display ?? c.code, system: c.system }));
      await deps.valueSets.upsertResolvedValueSet({
        oid,
        name: NAME_BY_OID[oid] ?? oid,
        version: null,
        source: "VSAC",
        codes,
        resolutionStatus: "RESOLVED",
        resolutionError: null,
        expansionHash: expansionHash(codes),
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
        payload: { oid, codes: codes.length, source: "VSAC", status: "RESOLVED" },
      });
      resolved++;
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      await deps.valueSets.upsertResolvedValueSet({
        oid,
        name: NAME_BY_OID[oid] ?? oid,
        version: null,
        source: "VSAC",
        codes: [],
        resolutionStatus: "ERROR",
        resolutionError: message,
        expansionHash: null,
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
  return { resolved, errors };
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
  const res = await runResolve({
    oids,
    client: httpVsacClient({ baseUrl, apiKey }),
    valueSets: stores.valueSets,
    events: stores.events,
    now: new Date().toISOString(),
  });
  console.log(`resolve-valuesets: ${res.resolved} resolved, ${res.errors} error(s), ${oids.length} target(s).`);
  return res.errors > 0 && res.resolved === 0 ? 1 : 0;
}
