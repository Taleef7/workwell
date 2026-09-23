/**
 * Quality-over-time history route (#E16 PR-2) — the persisted numerator/denominator-per-period read
 * Doug asked for ("how to know if they were compliant in December? October?"). A bounded table read of
 * the materialized `quality_snapshots` aggregate, never a re-scan of the per-subject `outcomes`.
 * Authenticated under /api/** by the worker's security matrix; read-only (all roles).
 *
 *   GET /api/quality/history?measureId=&scopeLevel=&scopeId=&tenant=&from=&to=
 *     → QualitySnapshotRow[] (period ASC), the time-series for the selected measure + scope;
 *     → 409 `snapshot_basis_unsafe` for a measure whose snapshots would understate its rate (#642).
 *
 * The series itself is still never a re-scan of the outcome history. The #642 check reads at most ONE
 * run's rows for the measure (none at all for an officially routed one) to learn whether the measure
 * produces out-of-population subjects — see `quality/snapshot-basis.ts`.
 *
 * `from`/`to` are inclusive `YYYY-MM` calendar-month bounds (400 on malformed — parity with the
 * `/api/programs` YYYY-MM-DD validator). Descriptive only — CQL `Outcome Status` stays authoritative
 * (ADR-008/ADR-021).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import type { QualityScopeLevel } from "../stores/quality-snapshot-store.ts";
import { monthlySnapshotsUnderstateRate, SNAPSHOT_BASIS_REFUSAL } from "../quality/snapshot-basis.ts";

interface QualityEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const SCOPE_LEVELS: readonly QualityScopeLevel[] = ["all", "tenant", "site", "provider"];

/** Validate an inclusive `YYYY-MM` calendar-month bound; returns undefined for a missing param. */
function parseMonth(raw: string | null, label: string): string | undefined {
  if (raw === null || raw === "") return undefined;
  const m = /^(\d{4})-(\d{2})$/.exec(raw);
  const month = m ? Number(m[2]) : 0;
  if (!m || month < 1 || month > 12) {
    throw new MonthError(`${label} must use YYYY-MM`);
  }
  return raw;
}

class MonthError extends Error {}

export async function handleQuality(req: Request, env: QualityEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  if (url.pathname !== "/api/quality/history") return null;

  const q = url.searchParams;
  // Require measureId to keep the read bounded: per-measure the worst case is ~12 months × the scope
  // fan-out (~a few thousand rows), whereas an unfiltered read would return the whole table (tens of
  // thousands after a full backfill of the 120k scale tenant). The UI always sends it.
  const measureId = q.get("measureId");
  if (!measureId) return json({ error: "invalid_request", message: "measureId is required" }, 400);

  let from: string | undefined;
  let to: string | undefined;
  try {
    from = parseMonth(q.get("from"), "from");
    to = parseMonth(q.get("to"), "to");
  } catch (err) {
    if (err instanceof MonthError) return json({ error: "invalid_request", message: err.message }, 400);
    throw err;
  }

  const scopeLevelRaw = q.get("scopeLevel");
  if (scopeLevelRaw && !SCOPE_LEVELS.includes(scopeLevelRaw as QualityScopeLevel)) {
    return json({ error: "invalid_request", message: `scopeLevel must be one of ${SCOPE_LEVELS.join(", ")}` }, 400);
  }

  const s = await getStores(env);
  // #642: refuse rather than serve a series that understates the rate. A 409 and not an empty array:
  // "no history yet" and "history exists but would be wrong" are different answers, and the panel must
  // be able to say which (the same shape as ADR-077's `run_compacted`).
  if (await monthlySnapshotsUnderstateRate(s.outcomes, measureId)) return json(SNAPSHOT_BASIS_REFUSAL, 409);
  const rows = await s.qualitySnapshots.querySnapshots({
    measureId,
    scopeLevel: (scopeLevelRaw as QualityScopeLevel) ?? undefined,
    scopeId: q.get("scopeId") ?? undefined,
    tenantId: q.get("tenant") ?? undefined,
    from,
    to,
  });
  return json(rows);
}
