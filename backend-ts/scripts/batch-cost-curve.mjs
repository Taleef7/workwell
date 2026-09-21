/**
 * #589 — is the batched per-subject cost flat in batch size, or does the curve bend?
 *
 * `wiring/official-executor-adapter.ts` records **11-16 ms per subject batched**, measured at 25 and
 * 100 subjects, and frames the saving as growing with the roster. The Maui nightly measured **42
 * ms/subject** at 500 (#588's phase timing, run `262c7ea3`). Before changing anything, re-run the
 * original measurement's own sizes on the current artifacts and see which of the two the curve
 * explains.
 *
 * Deliberately NOT a test: it is a measurement, it takes minutes, and its output is a number to put
 * in a comment rather than an assertion to gate a build.
 *
 *   node --import tsx scripts/batch-cost-curve.mjs
 *   WORKWELL_CURVE_SIZES=25,100,500 WORKWELL_CURVE_MEASURE=cms122 node --import tsx scripts/batch-cost-curve.mjs
 */
import { corpusDirectory } from "../src/engine/synthetic/corpus/corpus-directory.ts";
import { DEFAULT_CORPUS_SEED } from "../src/engine/synthetic/corpus/corpus-parameters.ts";
import { corpusBundleSource } from "../src/wiring/corpus-bundle-source.ts";
import { officialMeasureExecutor } from "../src/wiring/official-executor-adapter.ts";
import { officialTerminologyExpander } from "../src/wiring/official-terminology.ts";
import { loadOfficialArtifact } from "../src/wiring/official-artifacts.ts";

const MEASURE = process.env.WORKWELL_CURVE_MEASURE ?? "cms122";
const SIZES = (process.env.WORKWELL_CURVE_SIZES ?? "25,100,500").split(",").map((n) => Number(n.trim()));
const YEAR = Number(process.env.WORKWELL_CORPUS_POPULATION_YEAR ?? new Date().getUTCFullYear());
const EVALUATION_DATE = `${YEAR}-12-31`;
const REPEATS = Number(process.env.WORKWELL_CURVE_REPEATS ?? 3);

const artifact = loadOfficialArtifact(MEASURE);
if (!artifact) {
  console.error(`${MEASURE}: no vendored artifact — run 'pnpm vendor:official' first.`);
  process.exit(1);
}

const largest = Math.max(...SIZES);
const EMPLOYEES = corpusDirectory(DEFAULT_CORPUS_SEED, largest).EMPLOYEES;
const source = corpusBundleSource();

// Bundles built ONCE and reused across sizes, so the curve measures evaluation rather than
// generation — bundle construction is 0.33% of a batch (#588) and would otherwise be noise here.
const allSubjects = EMPLOYEES.map((employee) => ({
  subjectId: employee.externalId,
  patientBundle: source.bundleForSubject(employee, EVALUATION_DATE),
}));

const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });

// One warm pass: the first call pays the ELM parse and the terminology expansion, which is exactly
// the cost the batching claim is about amortising. Measuring it inside the curve would report the
// smallest batch as catastrophic and say nothing about the shape.
await executor.evaluateBatch(MEASURE, allSubjects.slice(0, Math.min(10, largest)), EVALUATION_DATE);

console.log(`${MEASURE} · ${EVALUATION_DATE} · ${REPEATS} repeats per size · bundles built once\n`);
console.log("  size    median ms    ms/subject     min      max");

const results = [];
for (const size of SIZES) {
  const subjects = allSubjects.slice(0, size);
  if (subjects.length < size) {
    console.log(`  ${String(size).padStart(4)}    (only ${subjects.length} subjects available — skipped)`);
    continue;
  }
  const times = [];
  for (let i = 0; i < REPEATS; i++) {
    const t0 = performance.now();
    await executor.evaluateBatch(MEASURE, subjects, EVALUATION_DATE);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const perSubject = median / size;
  results.push({ size, median, perSubject });
  console.log(
    `  ${String(size).padStart(4)}  ${median.toFixed(0).padStart(10)}  ${perSubject.toFixed(1).padStart(12)}  ` +
    `${times[0].toFixed(0).padStart(6)}  ${times[times.length - 1].toFixed(0).padStart(6)}`,
  );
}

if (results.length >= 2) {
  const first = results[0];
  const last = results[results.length - 1];
  const ratio = last.perSubject / first.perSubject;
  console.log(
    `\n  per-subject cost at ${last.size} is ${ratio.toFixed(2)}x its cost at ${first.size} — ` +
    (ratio > 1.3
      ? "the curve BENDS UPWARD: per-call cost is superlinear in batch size, so the comment's\n  \"the saving grows with the roster\" stops holding past some size."
      : ratio < 0.77
        ? "the saving still grows with the roster, so batch size does NOT explain the gap."
        : "roughly FLAT, so batch size does not explain the gap — look at artifact/terminology drift\n  or bundle size instead."),
  );
}
