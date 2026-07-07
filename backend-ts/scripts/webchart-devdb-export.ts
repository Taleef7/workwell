/**
 * webchart-devdb-export.ts — DEV-ONLY, one-time fixture generator (#246, WebChart dev-DB proof, PR-2).
 *
 * Reads MIE's seeded WebChart dev database (`ghcr.io/mieweb/dev-wcdb`, MariaDB 10.3.32) and emits
 * per-patient **WebChart-shaped FHIR payloads** as committed fixtures, plus a deterministic OH
 * enrollment roster. The committed fixtures are what the e2e test + the demo CLI read — runtime and CI
 * NEVER touch Docker or the DB. This script is only re-run to refresh the fixtures.
 *
 * Driver-free (locked decision, 2026-07-03): NO MariaDB/MySQL driver is added to `backend-ts`. It shells
 * `docker exec <container> mysql --batch --raw -N -e "<JSON_OBJECT query>"` (MariaDB 10.3 JSON functions)
 * to pull rows as one JSON object per line, then assembles + **serializes the final FHIR JSON in Node**
 * (`JSON.stringify`) — so NULLs/encoding/newlines are handled by a real serializer, not brittle DB
 * line-output. Descriptive only (ADR-008): it supplies coded FHIR; CQL decides compliance.
 *
 * Usage (Docker + the `wcdb` container running):
 *   pnpm tsx scripts/webchart-devdb-export.ts
 * Env overrides: WEBCHART_DEVDB_CONTAINER (wcdb), _DB (wc_miehr_wctroot), _USER (root), _PASS (pmg2bhok).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CONTAINER = process.env.WEBCHART_DEVDB_CONTAINER ?? "wcdb";
const DB = process.env.WEBCHART_DEVDB_DB ?? "wc_miehr_wctroot";
const USER = process.env.WEBCHART_DEVDB_USER ?? "root";
const PASS = process.env.WEBCHART_DEVDB_PASS ?? "pmg2bhok";

const OUT_DIR = fileURLToPath(new URL("../spike/webchart", import.meta.url));

/** Code systems — MUST match the URIs `webchart/terminology.ts` recognizes (it also tolerates aliases). */
const SYS = {
  LOINC: "http://loinc.org",
  CPT: "http://www.ama-assn.org/go/cpt",
  HCPCS: "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets",
} as const;

/** The wellness/eCQM measures the dev-DB sample can actually exercise (real LOINC/HCPCS present). */
const WELLNESS_MEASURES = ["diabetes_hba1c", "obesity_bmi", "cholesterol_ldl", "hypertension"];
const FEMALE_MEASURES = ["cms125"]; // screening mammography — enrolled for female patients only

type Row = Record<string, unknown>;

/** Run one JSON_OBJECT query and parse the `--batch --raw -N` output as NDJSON (one object per line). */
function queryJson(sql: string): Row[] {
  // Pass the password via MYSQL_PWD (piped into the container with `docker exec -e`) rather than `-p` on
  // argv — keeps it out of the container process list and silences mysql's "password insecure" warning.
  const stdout = execFileSync(
    "docker",
    ["exec", "-e", "MYSQL_PWD", CONTAINER, "mysql", `-u${USER}`, "--batch", "--raw", "-N", "-e", sql, DB],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MYSQL_PWD: PASS } },
  );
  const rows: Row[] = [];
  let bad = 0;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as Row);
    } catch {
      bad++; // skip a malformed row rather than abort the export
    }
  }
  if (bad) console.warn(`  (skipped ${bad} unparseable row(s))`);
  return rows;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const cptSystem = (cpt: string): string => (/^\d{5}$/.test(cpt) ? SYS.CPT : SYS.HCPCS); // G-codes etc. → HCPCS

/** Group rows by their `pat_id`. */
function groupByPat(rows: Row[]): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = String(r.pat_id);
    let arr = m.get(k);
    if (!arr) m.set(k, (arr = []));
    arr.push(r);
  }
  return m;
}

function main(): void {
  console.log(`Exporting WebChart dev-DB fixtures from container '${CONTAINER}' (db ${DB})…`);

  const patients = queryJson(
    `SELECT JSON_OBJECT('pat_id',pat_id,'first_name',first_name,'last_name',last_name,'sex',sex,` +
      `'birth_date',DATE_FORMAT(birth_date,'%Y-%m-%d')) FROM patients WHERE is_patient=1 ORDER BY pat_id`,
  );
  const observations = queryJson(
    `SELECT JSON_OBJECT('pat_id',o.pat_id,'loinc',oc.loinc_num,'name',oc.obs_name,'value',o.obs_result_dec,` +
      `'dt',DATE_FORMAT(COALESCE(o.obs_result_dt,o.obs_ts),'%Y-%m-%dT%H:%i:%s')) ` +
      `FROM observations_current o JOIN observation_codes oc ON oc.obs_code=o.obs_code ` +
      `WHERE oc.loinc_num IS NOT NULL AND oc.loinc_num<>'' ORDER BY o.pat_id`,
  );
  const procedures = queryJson(
    `SELECT JSON_OBJECT('pat_id',pat_id,'cpt',cpt_code,'dt',DATE_FORMAT(service_date,'%Y-%m-%dT%H:%i:%s')) ` +
      `FROM patient_procedures WHERE cpt_code IS NOT NULL AND cpt_code<>'' ORDER BY pat_id`,
  );
  console.log(`  patients=${patients.length} loinc-observations=${observations.length} coded-procedures=${procedures.length}`);

  const obsByPat = groupByPat(observations);
  const procByPat = groupByPat(procedures);

  const bundles: unknown[] = [];
  const roster: Record<string, string[]> = {};

  for (const pt of patients) {
    const patId = String(pt.pat_id);
    const subjectId = `wc-${patId}`;
    const obs = obsByPat.get(patId) ?? [];
    const proc = procByPat.get(patId) ?? [];
    if (!obs.length && !proc.length) continue; // only patients with codeable clinical data (faithful + bounded)

    const ref = { reference: `Patient/${subjectId}` };
    const sex = str(pt.sex);
    const entries: Array<{ resource: unknown }> = [
      {
        resource: {
          resourceType: "Patient",
          id: subjectId,
          name: [{ text: [str(pt.first_name), str(pt.last_name)].filter(Boolean).join(" ") || subjectId }],
          ...(sex === "F" ? { gender: "female" } : sex === "M" ? { gender: "male" } : {}),
          ...(str(pt.birth_date) ? { birthDate: str(pt.birth_date) } : {}),
        },
      },
    ];
    for (const o of obs) {
      const loinc = str(o.loinc);
      if (!loinc) continue;
      entries.push({
        resource: {
          resourceType: "Observation",
          status: "final",
          subject: ref,
          code: { coding: [{ system: SYS.LOINC, code: loinc, ...(str(o.name) ? { display: str(o.name) } : {}) }] },
          ...(str(o.dt) ? { effectiveDateTime: str(o.dt) } : {}),
          ...(o.value != null ? { valueQuantity: { value: Number(o.value) } } : {}),
        },
      });
    }
    for (const p of proc) {
      const cpt = str(p.cpt);
      if (!cpt) continue;
      entries.push({
        resource: {
          resourceType: "Procedure",
          status: "completed",
          subject: ref,
          code: { coding: [{ system: cptSystem(cpt), code: cpt }] },
          ...(str(p.dt) ? { performedDateTime: str(p.dt) } : {}),
        },
      });
    }

    bundles.push({ resourceType: "Bundle", type: "collection", entry: entries });
    // Deterministic OH roster: every included patient is in the wellness panel; cms125 (mammography) for
    // female patients. This is the WorkWell-side program membership the WebChart clinical data lacks.
    roster[subjectId] = [...WELLNESS_MEASURES, ...(sex === "F" ? FEMALE_MEASURES : [])];
  }

  mkdirSync(OUT_DIR, { recursive: true });
  // Serialize + validate (round-trip through JSON.parse) before writing the committed fixtures.
  const patientsJson = JSON.stringify(bundles, null, 2);
  const rosterJson = JSON.stringify(roster, null, 2);
  JSON.parse(patientsJson);
  JSON.parse(rosterJson);
  writeFileSync(path.join(OUT_DIR, "devdb-patients.json"), patientsJson + "\n");
  writeFileSync(path.join(OUT_DIR, "enrollment-roster.json"), rosterJson + "\n");

  console.log(`  wrote ${bundles.length} patient bundle(s) → spike/webchart/devdb-patients.json`);
  console.log(`  wrote roster for ${Object.keys(roster).length} subject(s) → spike/webchart/enrollment-roster.json`);
}

main();
