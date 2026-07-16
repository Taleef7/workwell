/**
 * `pnpm generate:webchart-import` — derive WebChart bulk-import files (synthetic ~30-patient
 * population) for the teatea trial (`docs/WEBCHART_TEATEA_RUNBOOK_2026-07-16.md` §4).
 *
 *   pnpm generate:webchart-import [--patients 30] [--as-of YYYY-MM-DD] [--out ../webchart-import] [--format csv|checklist|all]
 *
 * Emits MIE's documented Data-Migration CSV formats (verified from the `mieweb/docs` sources,
 * 2026-07-16 — see the generated README for source URLs and upload order):
 *   01-patients.csv      Chart Data CSV API (demographics; `patients.*` + `@patient_mrns.MR` headers)
 *   02-encounters.csv    Clinical Encounter CSV API (office visits — the eCQM qualifying-visit IPP gate)
 *   03-observations.csv  Observation Import (18 fixed columns; labs + vitals)
 *   04-injections.csv    Injections CSV API (immunizations; CVX in `injections.inject_code`)
 *   checklist.md         per-patient manual-entry fallback (also covers mammograms — WebChart has
 *                        no procedure CSV; enter those as completed orders in the UI)
 *   README.md            upload instructions + caveats + verification steps
 *
 * The cohort is DETERMINISTIC (index-derived, no randomness): five repeating clinical profiles
 * guarantee every outcome bucket appears — fully-compliant, poor-control (HbA1c > 9), stale/overdue,
 * missing-data, and due-soon/partial-series. Values carry the same real terminology the WebChart
 * crosswalk reads back (LOINC-compendium observation names, CVX codes, CPT visit codes) so the
 * seeded charts round-trip through teatea's FHIR API into real CQL outcomes. Synthetic only — never
 * PHI (CLAUDE.md hard rule). Descriptive only (ADR-008): this emits data; CQL decides outcomes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const USAGE =
  "usage: generate:webchart-import [--patients N] [--as-of YYYY-MM-DD] [--out <dir>] [--format csv|checklist|all]\n";
const BACKEND_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// cohort model
// ---------------------------------------------------------------------------

const FIRST_F = ["Amina", "Sara", "Fatima", "Maryam", "Zainab", "Hira", "Noor", "Ayesha", "Khadija", "Iqra"];
const FIRST_M = ["Omar", "Ali", "Hassan", "Bilal", "Usman", "Hamza", "Faisal", "Imran", "Tariq", "Junaid"];
const LAST = ["Khan", "Ahmed", "Malik", "Siddiqui", "Raza", "Sheikh", "Qureshi", "Baig", "Chaudhry", "Mirza"];

interface Obs {
  name: string; // Observation-Import "Observation Name" — must resolve in the instance's LOINC compendium
  loinc: string; // documented for the checklist/verification only (the import keys on name, not LOINC)
  value: string;
  units: string;
  daysAgo: number;
}
interface Shot {
  description: string;
  cvx: string;
  daysAgo: number;
}
interface Visit {
  daysAgo: number;
  extId: string;
}
interface Diagnosis {
  name: string;
  snomed: string; // the cms122 Diabetes expansion is SNOMED-only (44054006) — ICD entries won't match
  daysAgo: number;
}
interface Person {
  mrn: string;
  first: string;
  last: string;
  sex: "F" | "M";
  birthDate: string; // YYYY-MM-DD
  profile: number; // 0..4
  obs: Obs[];
  shots: Shot[];
  visits: Visit[];
  diagnoses: Diagnosis[]; // manual-entry items (problem list; the encounter CSV's ICD field can't carry these)
  mammogramDaysAgo?: number; // manual-entry item (no procedure CSV) — women in the cms125 age band
}

/** Deterministic cohort: index-derived names/ages/profiles; five profiles cover every bucket. */
function buildCohort(n: number, asOf: string): Person[] {
  const asOfYear = Number(asOf.slice(0, 4));
  const people: Person[] = [];
  for (let i = 0; i < n; i++) {
    const sex: "F" | "M" = i % 2 === 0 ? "F" : "M";
    const first = sex === "F" ? FIRST_F[i % FIRST_F.length]! : FIRST_M[i % FIRST_M.length]!;
    const last = LAST[Math.floor(i / 2) % LAST.length]!;
    // ages ~28..72 — keeps women inside cms125's 42–74 band for most of the cohort and everyone in cms122's 18–75
    const birthYear = 1954 + ((i * 7) % 45);
    const birthDate = `${birthYear}-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`;
    const profile = i % 5;
    const p: Person = {
      mrn: `WW-${String(i + 1).padStart(4, "0")}`,
      first,
      last,
      sex,
      birthDate,
      profile,
      obs: [],
      shots: [],
      visits: [],
      diagnoses: [],
    };

    const visit = (daysAgo: number) => p.visits.push({ daysAgo, extId: `${p.mrn}-visit-${p.visits.length + 1}` });
    const obs = (name: string, loinc: string, value: string, units: string, daysAgo: number) =>
      p.obs.push({ name, loinc, value, units, daysAgo });
    const shot = (description: string, cvx: string, daysAgo: number) => p.shots.push({ description, cvx, daysAgo });
    const diabetes = () =>
      p.diagnoses.push({ name: "Type 2 diabetes mellitus", snomed: "44054006", daysAgo: 1200 });

    const age = asOfYear - birthYear; // as-of-derived so a pinned --as-of stays deterministic across calendar years
    const mammoEligible = sex === "F" && age >= 42 && age <= 74;

    switch (profile) {
      case 0: // fully compliant
        visit(60);
        diabetes(); // cms122 IPP gate — must exist in the chart, the roster never stamps it
        obs("HbA1c", "4548-4", "6.9", "%", 30);
        obs("LDL", "2089-1", "110", "mg/dL", 60);
        obs("BMI", "39156-5", "24.5", "kg/m2", 90);
        obs("Systolic BP", "8480-6", "118", "mmHg", 45);
        obs("Diastolic BP", "8462-4", "76", "mmHg", 45);
        shot("Influenza seasonal injectable", "141", 100);
        shot("Tdap", "115", 730);
        shot("MMR", "03", 9000);
        shot("MMR", "03", 8900);
        shot("Varicella", "21", 9000);
        shot("Varicella", "21", 8900);
        shot("Hep B adult (Heplisav-B)", "189", 1885);
        shot("Hep B adult (Heplisav-B)", "189", 1825);
        if (mammoEligible) p.mammogramDaysAgo = 240;
        break;
      case 1: // poor control (cms122 numerator; hypertensive; obese) — everything present, values bad
        visit(45);
        diabetes(); // cms122 IPP gate
        obs("HbA1c", "4548-4", "10.2", "%", 40);
        obs("LDL", "2089-1", "165", "mg/dL", 70);
        obs("BMI", "39156-5", "31.4", "kg/m2", 80);
        obs("Systolic BP", "8480-6", "152", "mmHg", 50);
        obs("Diastolic BP", "8462-4", "95", "mmHg", 50);
        shot("Influenza seasonal injectable", "141", 90);
        shot("Td (adult)", "09", 1500);
        if (mammoEligible) p.mammogramDaysAgo = 300;
        break;
      case 2: // stale / overdue — data exists but outside every window
        visit(200);
        obs("HbA1c", "4548-4", "7.1", "%", 400);
        obs("LDL", "2089-1", "128", "mg/dL", 500);
        obs("BMI", "39156-5", "27.0", "kg/m2", 420);
        obs("Systolic BP", "8480-6", "131", "mmHg", 400);
        obs("Diastolic BP", "8462-4", "84", "mmHg", 400);
        shot("Influenza seasonal injectable", "140", 420);
        if (mammoEligible) p.mammogramDaysAgo = 1100; // ~3y — outside the cms125 window
        break;
      case 3: // missing data — chart exists, nothing else
        break;
      case 4: // due-soon / partial series
        visit(30);
        obs("HbA1c", "4548-4", "7.6", "%", 165); // inside diabetes_hba1c's 161–180d DUE_SOON band (evaluate within ~15d of --as-of)
        obs("BMI", "39156-5", "26.1", "kg/m2", 300);
        shot("Hep B adult", "43", 90); // 1 of 3 traditional doses — IN_PROGRESS
        shot("MMR", "03", 60); // 1 of 2 doses
        break;
    }
    people.push(p);
  }
  return people;
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function dateNDaysBefore(asOf: string, days: number): Date {
  const d = new Date(`${asOf}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const yyyymmdd = (d: Date) => iso(d).replace(/-/g, "");
const sqlDateTime = (d: Date) => `${iso(d)} 09:00:00`;

/** CSV field escaping — quote anything carrying a comma/quote/newline. */
const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const row = (fields: string[]) => fields.map(csv).join(",");

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ---------------------------------------------------------------------------
// emitters
// ---------------------------------------------------------------------------

function patientsCsv(people: Person[]): string {
  const header = "@patient_mrns.MR,patients.first_name,patients.last_name,patients.birth_date,patients.sex,patients.email";
  const lines = people.map((p) =>
    row([p.mrn, p.first, p.last, `${p.birthDate} 00:00:00`, p.sex, `${p.mrn.toLowerCase()}@workwell-demo.dev`]),
  );
  return [header, ...lines].join("\n") + "\n";
}

function encountersCsv(people: Person[], asOf: string): string {
  const header = "encounters.pat_id,encounters.pat_id_type,encounters.ext_id,encounters.visit_type,encounters.serv_date";
  const lines: string[] = [];
  for (const p of people) {
    for (const v of p.visits) {
      lines.push(row([p.mrn, "part:MR", v.extId, "office", sqlDateTime(dateNDaysBefore(asOf, v.daysAgo))]));
    }
  }
  return [header, ...lines].join("\n") + "\n";
}

const OBS_HEADER =
  "Patient ID,Patient Lastname,Patient Firstname,Patient Class,Observation Datetime,Observation Code," +
  "Observation Name,Observation Order,Observation Result,Observation Range,Observation Units," +
  "Observation Flag,Observation Status,Observer Code,Comment,Performing Lab,Encounter Ext ID,Encounter Interface";

function observationsCsv(people: Person[], asOf: string): string {
  const lines: string[] = [];
  for (const p of people) {
    for (const o of p.obs) {
      lines.push(
        row([
          p.mrn, p.last, p.first, "O",
          yyyymmdd(dateNDaysBefore(asOf, o.daysAgo)),
          "", o.name, "", o.value, "", o.units, "", "F", "",
          `LOINC ${o.loinc}`, // comment column — records the intended LOINC for the compendium check
          "WorkWell Synthetic", "", "",
        ]),
      );
    }
  }
  return [OBS_HEADER, ...lines].join("\n") + "\n";
}

const INJ_HEADER =
  "documents.pat_id,documents.pat_id_type,documents.ext_doc_id,documents.service_date,documents.origin_id," +
  "documents.origin_id_type,documents.service_location,injections.description,injections.inject_code," +
  "injections.vial,injections.series,injections.dose,injections.unit_measure,injections.route,injections.site," +
  "injections.manufacturer,injections.expiration_date,injections.reaction";

function injectionsCsv(people: Person[], asOf: string): string {
  const lines: string[] = [];
  let docId = 1;
  for (const p of people) {
    for (const s of p.shots) {
      lines.push(
        row([
          p.mrn, "part:MR", `WWDOC-${String(docId++).padStart(5, "0")}`,
          sqlDateTime(dateNDaysBefore(asOf, s.daysAgo)),
          "", "", "OFFICE", s.description, s.cvx,
          "", "", "0.5", "mL", "IM", "LD", "", "", "",
        ]),
      );
    }
  }
  return [INJ_HEADER, ...lines].join("\n") + "\n";
}

const PROFILE_NAMES = ["fully compliant", "poor control", "stale/overdue", "missing data", "due-soon/partial series"];

function checklistMd(people: Person[], asOf: string): string {
  const lines: string[] = [];
  lines.push(`# teatea manual-entry checklist — ${people.length} synthetic patients (as-of ${asOf})`);
  lines.push("");
  lines.push("Fallback for when a CSV import tool is unavailable on the trial — and the ONLY path for");
  lines.push("mammograms (WebChart has no procedure CSV; enter those as completed screening-mammography");
  lines.push("orders, CPT 77067). Enter each patient via patient registration, then their chart items.");
  lines.push("");
  for (const p of people) {
    lines.push(`## ${p.mrn} — ${p.first} ${p.last} (${p.sex}, DOB ${p.birthDate}) — profile: ${PROFILE_NAMES[p.profile]}`);
    if (p.visits.length + p.obs.length + p.shots.length + p.diagnoses.length === 0 && p.mammogramDaysAgo === undefined) {
      lines.push("- register the chart only (deliberately empty — the MISSING_DATA cohort)");
    }
    for (const d of p.diagnoses)
      lines.push(
        `- problem-list diagnosis **${d.name}** (SNOMED CT ${d.snomed} — must be SNOMED; an ICD entry won't match the cms122 value set) onset ~${iso(dateNDaysBefore(asOf, d.daysAgo))}`,
      );
    for (const v of p.visits) lines.push(`- office visit (CPT 99213) on ${iso(dateNDaysBefore(asOf, v.daysAgo))}`);
    for (const o of p.obs)
      lines.push(`- observation **${o.name}** (LOINC ${o.loinc}): ${o.value} ${o.units} on ${iso(dateNDaysBefore(asOf, o.daysAgo))}`);
    for (const s of p.shots)
      lines.push(`- immunization **${s.description}** (CVX ${s.cvx}) on ${iso(dateNDaysBefore(asOf, s.daysAgo))}`);
    if (p.mammogramDaysAgo !== undefined)
      lines.push(`- screening mammogram (CPT 77067, completed order/procedure) on ${iso(dateNDaysBefore(asOf, p.mammogramDaysAgo))}`);
    lines.push("");
  }
  return lines.join("\n");
}

function readmeMd(people: Person[], asOf: string): string {
  return `# WebChart import bundle — ${people.length} synthetic patients (as-of ${asOf})

Generated by \`pnpm generate:webchart-import\` (WorkWell). **Synthetic data — never PHI.**

## Upload order (Control Panel → Data Import tab; role setting "Allow .csv data import" must be YES)

1. \`01-patients.csv\` — Chart Data CSV API (interface: \`WC_DATA_IMPORT\`; creates the charts — MRN partition \`MR\`)
2. \`02-encounters.csv\` — Clinical Encounter CSV API (office visits; the eCQM qualifying-visit gate)
3. \`03-observations.csv\` — Observation Import (labs + vitals; date format \`YYYYMMDD\`)
4. \`04-injections.csv\` — Injections CSV API (immunizations; CVX in \`injections.inject_code\`)
5. Mammograms: **manual** — no procedure CSV exists; see \`checklist.md\` (completed order, CPT 77067)
6. Diabetes diagnoses: **manual** — problem-list entries per \`checklist.md\`, **SNOMED CT 44054006**
   (the cms122 Diabetes value-set expansion is SNOMED-only, so the encounter CSV's ICD diagnosis
   field cannot satisfy it; without this entry every patient reads out-of-IPP for cms122)

Tick **Verbose** on the upload form the first time; a failed-rows file can be downloaded, fixed, and
re-uploaded. **Test with 2–3 rows first** (MIE's own best-practice note).

## Caveats (verify on first upload; formats sourced from the mieweb/docs repo 2026-07-16)

- \`patients.sex\` follows the documented \`patients.<db_column>\` header pattern but its exact header
  string was not byte-verified — if the importer rejects it, check the "Sample Demographics File"
  tab of MIE's Chart Data CSV spec sheet and rename.
- \`part:MR\` as \`pat_id_type\` (encounters/injections) is inferred from the documented \`part:\` id-type
  prefix. If rejected, re-run the failed rows with \`id:pat_id\` after looking up the chart ids, or
  add \`patients.extern_id1\` to 01 and use \`id:ext_id\`.
- **Observation Import keys on Observation NAME, not LOINC.** The FHIR read-back only carries the
  LOINC coding if the instance's observation-code compendium maps that name (Menu → Control Panel →
  Observation Codes editor). After uploading, spot-check ONE patient:
  \`GET /webchart.cgi/fhir/Observation?patient={id}\` — every observation should carry its LOINC
  (intended codes are recorded in each row's Comment column and in \`checklist.md\`). If a name
  resolved without LOINC, map it in the Observation Codes editor and re-check.

## Cohort design (deterministic, 5 repeating profiles)

${PROFILE_NAMES.map((n, i) => `- profile ${i} (every 5th patient): ${n}`).join("\n")}

Together these guarantee every WorkWell outcome bucket (COMPLIANT / DUE_SOON / OVERDUE /
MISSING_DATA — EXCLUDED needs a waiver, set one manually if wanted) across the runnable measures.
`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  let patients = 30;
  let asOf = new Date().toISOString().slice(0, 10);
  let out = path.join(BACKEND_ROOT, "..", "webchart-import");
  let format: "csv" | "checklist" | "all" = "all";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--patients") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1 || v > 500) return usageError();
      patients = v;
    } else if (arg === "--as-of") {
      const v = argv[++i];
      if (!v || !isValidDate(v)) return usageError();
      asOf = v;
    } else if (arg === "--out") {
      const v = argv[++i];
      if (!v) return usageError();
      out = path.isAbsolute(v) ? v : path.join(BACKEND_ROOT, v);
    } else if (arg === "--format") {
      const v = argv[++i];
      if (v !== "csv" && v !== "checklist" && v !== "all") return usageError();
      format = v;
    } else {
      process.stderr.write(`unrecognized argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }

  const people = buildCohort(patients, asOf);
  mkdirSync(out, { recursive: true });
  const wrote: string[] = [];
  const write = (name: string, content: string) => {
    writeFileSync(path.join(out, name), content);
    wrote.push(name);
  };

  if (format !== "checklist") {
    write("01-patients.csv", patientsCsv(people));
    write("02-encounters.csv", encountersCsv(people, asOf));
    write("03-observations.csv", observationsCsv(people, asOf));
    write("04-injections.csv", injectionsCsv(people, asOf));
  }
  if (format !== "csv") write("checklist.md", checklistMd(people, asOf));
  write("README.md", readmeMd(people, asOf));

  const shots = people.reduce((n, p) => n + p.shots.length, 0);
  const obs = people.reduce((n, p) => n + p.obs.length, 0);
  const visits = people.reduce((n, p) => n + p.visits.length, 0);
  process.stdout.write(
    `wrote ${wrote.join(", ")} to ${out}\n` +
      `cohort: ${people.length} patients, ${visits} visits, ${obs} observations, ${shots} immunizations, ` +
      `${people.filter((p) => p.mammogramDaysAgo !== undefined).length} mammograms (manual), as-of ${asOf}\n`,
  );
  return 0;
}

function usageError(): number {
  process.stderr.write(USAGE);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
