/**
 * `pnpm evaluate:webchart-live` — evaluate a LIVE WebChart-contract FHIR endpoint (the teatea trial,
 * or the local HAPI "fake WebChart", ADR-032) through the unchanged ingress + engine.
 *
 *   WORKWELL_WEBCHART_BASE_URL=http://localhost:8081 WORKWELL_WEBCHART_API_KEY=local-dev \
 *     pnpm evaluate:webchart-live --roster spike/webchart/enrollment-roster.json --date 2024-06-01
 *
 * Unlike `evaluate:webchart-devdb` (committed fixtures, no HTTP) this drives `httpWebChartClient`
 * over real HTTP: paged `GET /fhir/Patient`, per-resource `?patient=` composition, `link[next]`
 * pagination + the off-origin guard, and the Authorization header (static bearer against HAPI,
 * SMART Backend Services against a registered WebChart client).
 *
 * Flags:
 *   --list-patients        fetch the population and print a ROSTER TEMPLATE (JSON) on stdout —
 *                          `> roster.json` yields a valid file; the human-readable patient table
 *                          goes to stderr. Template values are pre-filled with the selected
 *                          measures (prune per subject as needed).
 *   --roster <path>        enrollment roster (subjectId → measureIds); required for evaluation.
 *   --date YYYY-MM-DD      evaluation date (default: today — live data is contemporaneous; use
 *                          --date 2024-06-01 against the HAPI fixtures to reproduce the devdb mix).
 *   --measures a,b,c       measure ids to evaluate (default: the devdb whitelist).
 *   --page-size N          FHIR `_count` per page (forces real multi-page pagination).
 *
 * Fail-fast when the WebChart seam is unconfigured — a silent fallback to the JSON source would
 * fake a "live" pass. The single population fetch is reused across measures (M measures ≠ M
 * fetches). Read-only + descriptive (ADR-008): nothing is persisted, no audit event (the same
 * posture as `evaluate:webchart-devdb`); the CQL engine decides every outcome.
 */
import { readFileSync } from "node:fs";
import type { OutcomeStatus } from "../../evaluate-measure.ts";
import { MEASURE_BINDINGS } from "../../synthetic/measure-bindings.ts";
import { webChartConfigFromEnv, webChartDataSource, type DataSourceEnv } from "../data-source.ts";
import { fixtureWebChartClient, httpWebChartClient, type WebChartClient } from "./webchart-client.ts";
import { parseEnrollmentRoster, evaluateSourceWithRoster } from "../enrollment/roster.ts";
import { BUCKETS, isValidDate, measureTableLines, type MeasureSummary } from "./report-table.ts";
import { DEVDB_WHITELIST } from "./devdb-cli.ts";

const USAGE =
  "usage: evaluate:webchart-live [--list-patients] [--roster <path>] [--date YYYY-MM-DD] " +
  "[--measures a,b,c] [--page-size N]\n";

export interface LiveCliIo {
  env?: DataSourceEnv;
  /** Test injection — overrides the HTTP transport, never the config gate. */
  client?: WebChartClient;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Injectable "today" (YYYY-MM-DD) so tests are date-stable. */
  today?: string;
}

interface PatientRow {
  id: string;
  name: string;
  gender: string;
  birthDate: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Tolerant Patient extraction from a raw per-patient payload (Bundle, resource array, or resource). */
function patientOf(payload: unknown): PatientRow | undefined {
  const resources: unknown[] = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.entry)
      ? payload.entry.map((e) => (isObject(e) ? e.resource : undefined))
      : [payload];
  for (const r of resources) {
    if (!isObject(r) || r.resourceType !== "Patient" || typeof r.id !== "string") continue;
    const name0 = Array.isArray(r.name) && isObject(r.name[0]) ? (r.name[0] as Json) : undefined;
    const given = Array.isArray(name0?.given) ? (name0!.given as unknown[]).join(" ") : "";
    const family = typeof name0?.family === "string" ? name0.family : "";
    return {
      id: r.id,
      name: [given, family].filter(Boolean).join(" ") || "(unnamed)",
      gender: typeof r.gender === "string" ? r.gender : "",
      birthDate: typeof r.birthDate === "string" ? r.birthDate : "",
    };
  }
  return undefined;
}

export async function runLiveCli(argv: string[], io?: LiveCliIo): Promise<number> {
  const env = io?.env ?? (process.env as DataSourceEnv);
  const stdout = io?.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = io?.stderr ?? ((s: string) => process.stderr.write(s));

  let listPatients = false;
  let rosterPath: string | undefined;
  let evaluationDate: string | undefined;
  let measures = DEVDB_WHITELIST;
  let pageSize: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--list-patients") {
      listPatients = true;
    } else if (arg === "--roster") {
      rosterPath = argv[++i];
      if (!rosterPath) return usage(stderr);
    } else if (arg === "--date") {
      const v = argv[++i];
      if (!v || !isValidDate(v)) return usage(stderr);
      evaluationDate = v;
    } else if (arg === "--measures") {
      const v = argv[++i];
      if (!v) return usage(stderr);
      measures = v.split(",").map((m) => m.trim()).filter(Boolean);
      const unknown = measures.filter((m) => !(m in MEASURE_BINDINGS));
      if (measures.length === 0 || unknown.length > 0) {
        stderr(`unknown measure(s): ${unknown.join(", ") || "(none given)"}\n${USAGE}`);
        return 2;
      }
    } else if (arg === "--page-size") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) return usage(stderr);
      pageSize = v;
    } else {
      stderr(`unrecognized argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }

  const cfg = webChartConfigFromEnv(env);
  if (!cfg) {
    stderr(
      "WebChart is not configured — refusing to run (a silent JSON fallback would fake a live pass).\n" +
        "set WORKWELL_WEBCHART_BASE_URL plus WORKWELL_WEBCHART_API_KEY (static bearer, e.g. local HAPI)\n" +
        "or WORKWELL_WEBCHART_CLIENT_ID + WORKWELL_WEBCHART_PRIVATE_KEY (SMART Backend Services).\n",
    );
    return 2;
  }
  if (!listPatients && !rosterPath) {
    stderr(`--roster is required for evaluation (generate a template with --list-patients)\n${USAGE}`);
    return 2;
  }

  // parse the roster BEFORE the network fetch — a typo'd path must not cost a live population pull
  let roster: ReturnType<typeof parseEnrollmentRoster> | undefined;
  if (!listPatients) {
    try {
      roster = parseEnrollmentRoster(JSON.parse(readFileSync(rosterPath!, "utf8")));
    } catch (err) {
      stderr(`roster file ${rosterPath}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }

  let host = cfg.baseUrl;
  try {
    host = new URL(cfg.baseUrl).host;
  } catch {
    /* keep raw */
  }
  const auth = cfg.clientId && cfg.privateKeyPem ? "smart-backend-services" : "static-bearer";

  const client = io?.client ?? httpWebChartClient(cfg, pageSize ? { pageSize } : undefined);
  let payloads: unknown[];
  try {
    payloads = await client.fetchPatientPayloads();
  } catch (err) {
    stderr(`live fetch failed against ${host}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (listPatients) {
    const rows = payloads.map(patientOf).filter((p): p is PatientRow => p !== undefined);
    if (rows.length !== payloads.length) {
      stderr(`warning: ${payloads.length - rows.length} of ${payloads.length} payloads carried no recoverable Patient — omitted from the template\n`);
    }
    stderr(`WebChart live population — ${rows.length} patients from ${host} (auth: ${auth})\n\n`);
    stderr(`  ${"id".padEnd(24)}${"name".padEnd(30)}${"gender".padEnd(10)}birthDate\n`);
    stderr(`  ${"-".repeat(72)}\n`);
    for (const p of rows) stderr(`  ${p.id.padEnd(24)}${p.name.padEnd(30)}${p.gender.padEnd(10)}${p.birthDate}\n`);
    stderr("\nroster template on stdout — redirect with:  --list-patients > roster.json\n");
    const template = Object.fromEntries(rows.map((p) => [p.id, measures]));
    stdout(JSON.stringify(template, null, 2) + "\n");
    return 0;
  }

  const asOf = evaluationDate ?? io?.today ?? new Date().toISOString().slice(0, 10);
  const summaries: MeasureSummary[] = [];
  for (const measureId of measures) {
    // one HTTP fetch total: the already-fetched payloads replay through a fixture client per measure
    const src = webChartDataSource(cfg, fixtureWebChartClient(payloads));
    const res = await evaluateSourceWithRoster(src, measureId, roster!, { evaluationDate: asOf });
    const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<OutcomeStatus, number>;
    for (const r of res.results) if (r.ok && r.outcome) counts[r.outcome.outcome]++;
    summaries.push({ measureId, total: res.results.filter((r) => r.ok).length, counts });
  }

  const nonMissing = summaries.reduce((n, m) => n + m.total - m.counts.MISSING_DATA, 0);
  const lines: string[] = [];
  lines.push(`WebChart LIVE evaluation — ${payloads.length} patients from ${host} (auth: ${auth}), as-of ${asOf}`);
  lines.push("(live-fetched FHIR → the unchanged CQL engine; read-only + descriptive, ADR-008)");
  lines.push("");
  lines.push(...measureTableLines(summaries));
  lines.push("");
  lines.push(`  → ${nonMissing} real (non-MISSING_DATA) outcomes across ${measures.length} measures.`);
  stdout(lines.join("\n") + "\n");
  return 0;
}

function usage(stderr: (s: string) => void): number {
  stderr(USAGE);
  return 2;
}
