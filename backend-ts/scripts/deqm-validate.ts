/**
 * Measure our FHIR MeasureReports against the DEQM STU5 profiles — the FHIR-column counterpart of
 * `qrda-schematron-check.py` (ROADMAP_2026-08-04 §4 V3, milestone B6).
 *
 *     corepack pnpm exec tsx scripts/deqm-validate.ts --validator <path/to/validator_cli.jar> \
 *         [--out <dir>] [--json] [--inject-invalid]
 *
 * ## Exit code: the FLOOR is enforced, the GAP is not
 *
 * **Exit 1 iff the base-R4 run has errors.** A non-zero DEQM count is the expected state today, so
 * gating on it would block every run; a non-zero BASE count means a builder started emitting invalid
 * FHIR, which is a production regression. An earlier version printed "must stay at 0" and always exited
 * 0, which left the floor invisible to every shell caller — a control that reads as present and cannot
 * fire (Codex, #392).
 *
 * `--inject-invalid` corrupts the first report's `status` so the floor provably CAN fire. Measured both
 * arms: clean → `0 base errors, exit 0`; injected → `2 base errors, exit 1`. Re-run both if you touch
 * the exit logic — a guard nobody has watched fail is a guard nobody knows works.
 *
 * ## The findings ARE pinned in CI — in `src/fhir/measure-report.test.ts`
 *
 * Four tests pin the measured gap: `deqm-0` (canonical carries no version), the contained reporter's
 * inability to satisfy `qicore-organization`, `deqm-3` (no measure-scoring on root or group), and the
 * full-float `measureScore` that `qrda3-export.ts` formats differently. They pin the NON-CONFORMANT state
 * deliberately — we do not claim a DEQM `meta.profile`, so they record the distance to it. **When one is
 * fixed, invert the test rather than deleting it, and re-run this script** so the error count is measured
 * to have fallen rather than asserted to have.
 *
 * ## Why this exists as a script and not a test
 *
 * Same reasoning as the Schematron checker, and the same discipline. It needs **Java 17+** and a
 * ~187 MB `validator_cli.jar`, neither of which is a backend-ts dependency and neither of which may
 * become one (CLAUDE.md forbids new deps without approval). It also fetches IG packages from
 * `packages.fhir.org` on first run. So it is **deliberately NOT in CI**; the structural regressions it
 * finds get pinned in TypeScript in `src/fhir/measure-report.test.ts`, each assertion citing the
 * constraint key it stands for. This script is how those assertions get their authority, and how you
 * re-derive them when DEQM moves.
 *
 * ## The two runs are the point, and they are different questions
 *
 * 1. **BASE R4** — "is this a valid FHIR resource at all?" This is our floor and it must stay at 0
 *    errors. Nothing about DEQM is asserted here.
 * 2. **DEQM profile, requested EXPLICITLY via `-profile`** — "how far are we from the DEQM profile?"
 *
 * The second run is a **gap measurement, not a conformance claim**, and the distinction is load-bearing.
 * `measure-report.ts` deliberately does **not** stamp `meta.profile` with a DEQM canonical
 * (STANDARDS_CONFORMANCE.md says so), because claiming a profile we do not meet is the misdeclaration
 * this codebase keeps refusing — exactly the `…24.1.3` / `…27.1.2` mistake ADR-050 corrected for QRDA.
 * Asking the validator to check us against a profile we do not claim is the honest way to find out what
 * claiming it would cost. **Do not add `meta.profile` on the strength of this script alone** — add it
 * when the DEQM run reaches 0 errors, and then this script's first run proves it stayed valid R4.
 *
 * ## Reproducibility
 *
 * `validator_cli.jar` is published as a rolling "latest", so pinning a SHA-256 the way the Schematron
 * checker does would be permanently stale rather than protective. Instead the run RECORDS the jar's
 * SHA-256 and the validator's own version banner in its output, so a number in a doc can always be tied
 * to the tool that produced it. Get the jar from:
 *     https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar
 * It is gitignored — never vendored.
 *
 * ## What the DEQM package drags in, and why that is worth reading
 *
 * `hl7.fhir.us.davinci-deqm#5.0.0` resolves `hl7.fhir.us.qicore#6.0.0` and `hl7.fhir.us.core#6.1.0`.
 * That is independent confirmation of ROADMAP_2026-08-04 §6 correction 2: the published quality stack is
 * on **QI-Core 6**, not STU7. The run prints the resolved package list for that reason.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildIndividualMeasureReport,
  buildSummaryMeasureReportFromCounts,
  type MeasureReport,
} from "../src/fhir/measure-report.ts";
import type { OutcomeRecord } from "../src/stores/outcome-store.ts";
import type { RunRecord } from "../src/stores/run-store.ts";

const DEQM_IG = "hl7.fhir.us.davinci-deqm#5.0.0";
const P = "http://hl7.org/fhir/us/davinci-deqm/StructureDefinition";
/** DEQM's MeasureReport profiles, by the report shape each one governs. */
const PROFILE = {
  summary: `${P}/summary-measurereport-deqm`,
  individual: `${P}/indv-measurereport-deqm`,
} as const;

/**
 * A fixed generation timestamp and fixed period, so two runs of this script differ only where the
 * BUILDERS differ. `id` is a fresh UUID per report by construction (`reportMetadata`), so the output is
 * not byte-stable — but nothing asserted here depends on the id.
 */
const GENERATED_AT = "2026-08-04T12:00:00.000Z";
const run = {
  id: "deqm-validate",
  measurementPeriodStart: "2025-01-01T00:00:00.000Z",
  measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
} as unknown as RunRecord;

/** The official identity a routed cms125 outcome carries (ADR-046 shape). */
const officialIdentity = {
  measureUrl: "https://madie.cms.gov/Measure/CMS125FHIRBreastCancerScreen",
  version: "1.0.000",
  ecqmId: "125FHIR",
} as unknown as Parameters<typeof buildSummaryMeasureReportFromCounts>[4];

const officialOutcome = {
  subjectId: "emp-006",
  status: "COMPLIANT",
  evidence: {
    official: {
      measureUrl: "https://madie.cms.gov/Measure/CMS125FHIRBreastCancerScreen",
      version: "1.0.000",
      ecqmId: "125FHIR",
      populationResults: [
        { populationType: "initial-population", result: true },
        { populationType: "denominator", result: true },
        { populationType: "denominator-exclusion", result: false },
        { populationType: "numerator", result: true },
      ],
    },
  },
} as unknown as OutcomeRecord;

interface Case {
  name: string;
  profile: string;
  /** Why this case is in the set — printed, so the sample is legible rather than arbitrary. */
  why: string;
  report: MeasureReport;
}

/**
 * The four report shapes a receiver can actually be handed. Both provenance paths are here on purpose:
 * an official-routed report and an authored one, which ADR-046 makes structurally different in `measure`
 * and `improvementNotation`. cms122 is included because its official numerator is INVERSE, so it is the
 * one report whose `improvementNotation` is `decrease`.
 */
const cases = (): Case[] => [
  {
    name: "summary-official-cms125",
    profile: PROFILE.summary,
    why: "the routed, proportion-scored summary a receiver would aggregate",
    report: buildSummaryMeasureReportFromCounts(
      run, "cms125", { ipp: 150, denom: 150, denex: 47, numer: 2, denexcep: 0 }, GENERATED_AT, officialIdentity,
    ),
  },
  {
    name: "summary-official-cms122-inverse",
    profile: PROFILE.summary,
    why: "the INVERSE measure — improvementNotation 'decrease' (ADR-046)",
    report: buildSummaryMeasureReportFromCounts(
      run, "cms122",
      { ipp: 64, denom: 64, denex: 32, numer: 31, denexcep: 0 },
      GENERATED_AT,
      { measureUrl: "https://madie.cms.gov/Measure/CMS122FHIRDiabetesAssessGT9Pct", version: "1.0.000", ecqmId: "122FHIR" } as unknown as Parameters<typeof buildSummaryMeasureReportFromCounts>[4],
    ),
  },
  {
    name: "summary-authored-audiogram",
    profile: PROFILE.summary,
    why: "the AUTHORED path — urn:workwell:measure, which ADR-046 d3 keeps deliberately local",
    report: buildSummaryMeasureReportFromCounts(
      run, "audiogram", { ipp: 10, denom: 10, denex: 1, numer: 6, denexcep: 0 }, GENERATED_AT, null,
    ),
  },
  {
    name: "individual-official-cms125",
    profile: PROFILE.individual,
    why: "one subject's membership — the QRDA Category I analogue",
    report: buildIndividualMeasureReport(officialOutcome, run, "cms125", GENERATED_AT),
  },
];

interface Issue { severity: string; expression: string; text: string; constraint: string | null }

/** `deqm-0`, `deqm-3`, `dom-6` … — the key is what a regression test cites, so pull it out explicitly. */
const CONSTRAINT = /Constraint failed: ([A-Za-z][A-Za-z0-9-]*)\b/;

function validate(jar: string, file: string, args: string[]): { issues: Issue[]; packages: string[] } {
  let raw: string;
  const outcomeFile = `${file}.outcome.json`;
  try {
    raw = execFileSync(
      "java",
      ["-jar", jar, file, "-version", "4.0.1", "-output", outcomeFile, ...args],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    // The validator exits non-zero when it finds errors, which is a RESULT, not a failure to run.
    // Distinguishing them matters: a crashed validator that we read as "0 errors" is the silent
    // false-pass this codebase keeps refusing.
    const err = e as { stdout?: string; stderr?: string; status?: number };
    raw = err.stdout ?? "";
    if (!raw.includes("Done. Times:")) {
      throw new Error(`validator did not complete (exit ${err.status}): ${(err.stderr ?? raw).slice(-800)}`);
    }
  }
  const packages = [...raw.matchAll(/Package Summary: \[(.+?)\]/g)].at(-1)?.[1]?.split(", ") ?? [];
  const outcome = JSON.parse(readFileSync(outcomeFile, "utf8")) as {
    issue?: Array<{ severity: string; expression?: string[]; details?: { text?: string }; diagnostics?: string }>;
  };
  const issues = (outcome.issue ?? []).map((i) => {
    const text = i.details?.text ?? i.diagnostics ?? "";
    return {
      severity: i.severity,
      expression: i.expression?.[0] ?? "(resource)",
      text,
      constraint: CONSTRAINT.exec(text)?.[1] ?? null,
    };
  });
  return { issues, packages };
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const jar = arg("--validator");
  if (!jar) {
    console.error("usage: tsx scripts/deqm-validate.ts --validator <validator_cli.jar> [--out <dir>] [--json]");
    console.error("get the jar: https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar");
    process.exit(2);
  }
  const out = arg("--out") ?? join(process.cwd(), ".deqm-validate");
  mkdirSync(out, { recursive: true });

  const jarSha = createHash("sha256").update(readFileSync(jar)).digest("hex");
  const results: Array<{
    case: string; why: string; profile: string;
    base: { errors: number; issues: Issue[] };
    deqm: { errors: number; issues: Issue[] };
  }> = [];
  let packages: string[] = [];

  // `--inject-invalid` breaks the FIRST report's `status` to an illegal code, so the base-R4 floor
  // provably CAN fire. A guard nobody has watched fail is a guard nobody knows works — the same
  // mutation discipline ADR-055's fixes were held to, and the reason this flag exists rather than a
  // comment claiming the exit code is correct.
  const inject = argv.includes("--inject-invalid");

  for (const [i, c] of cases().entries()) {
    const file = join(out, `${c.name}.json`);
    const report = inject && i === 0
      ? { ...c.report, status: "not-a-real-status" as unknown as MeasureReport["status"] }
      : c.report;
    writeFileSync(file, JSON.stringify(report, null, 2));

    // Run 1 — base R4. The floor: this must stay at 0 errors whatever DEQM says.
    const base = validate(jar, file, []);
    // Run 2 — the DEQM profile, requested explicitly. A GAP measurement, not a claim.
    const deqm = validate(jar, file, ["-ig", DEQM_IG, "-profile", c.profile]);
    if (deqm.packages.length) packages = deqm.packages;

    const errs = (is: Issue[]) => is.filter((i) => i.severity === "error" || i.severity === "fatal");
    results.push({
      case: c.name, why: c.why, profile: c.profile,
      base: { errors: errs(base.issues).length, issues: base.issues },
      deqm: { errors: errs(deqm.issues).length, issues: deqm.issues },
    });
  }

  // The FLOOR is enforced, the GAP is not — and the asymmetry is the whole exit-code policy.
  // A non-zero DEQM count is the expected state today, so gating on it would block every run. A
  // non-zero BASE count means a builder started emitting invalid FHIR, which is a regression in
  // production output. Documenting "must stay at 0" without returning non-zero left that floor
  // invisible to any shell caller (Codex, #392) — a control that reads as present and cannot fire.
  const baseErrors = results.reduce((n, r) => n + r.base.errors, 0);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ validatorSha256: jarSha, deqmIg: DEQM_IG, packages, results }, null, 2));
    process.exit(baseErrors > 0 ? 1 : 0);
  }

  console.log(`\nvalidator_cli.jar sha256: ${jarSha}`);
  console.log(`DEQM IG: ${DEQM_IG}`);
  const qicore = packages.find((p) => p.startsWith("hl7.fhir.us.qicore"));
  const uscore = packages.find((p) => p.startsWith("hl7.fhir.us.core"));
  if (qicore || uscore) {
    console.log(`resolved quality stack: ${[qicore, uscore].filter(Boolean).join(", ")}`);
    console.log("  ^ the published stack DEQM STU5 binds — see ROADMAP_2026-08-04 §6 correction 2");
  }

  let deqmTotal = 0;
  for (const r of results) {
    deqmTotal += r.deqm.errors;
    console.log(`\n── ${r.case}  (${r.why})`);
    console.log(`   base R4      : ${r.base.errors} error(s)`);
    console.log(`   DEQM profile : ${r.deqm.errors} error(s)   [${r.profile.split("/").pop()}]`);
    for (const i of r.deqm.issues.filter((x) => x.severity === "error" || x.severity === "fatal")) {
      console.log(`     - ${i.constraint ? `[${i.constraint}] ` : ""}${i.expression}: ${i.text.split("\n")[0]}`);
    }
  }

  console.log(`\n=== BASE R4: ${baseErrors} error(s) across ${results.length} reports — this is the floor ===`);
  console.log(`=== DEQM   : ${deqmTotal} error(s) — the GAP, not a conformance claim ===`);
  console.log(`reports + OperationOutcomes written to ${out}`);
  if (baseErrors > 0) {
    console.error(
      `\nFAIL: the base-R4 floor regressed — ${baseErrors} error(s). A builder is emitting invalid FHIR.\n` +
        `(The DEQM gap above is expected and does NOT affect this exit code.)`,
    );
    process.exit(1);
  }
}

main();
