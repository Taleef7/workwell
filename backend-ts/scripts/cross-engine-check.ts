/**
 * Cross-execute the official MADiE test cases through a SECOND, independently written measure engine
 * and compare — ROADMAP_2026-08-04 §4 **V4**, milestone B7.
 *
 *     corepack pnpm exec tsx scripts/cross-engine-check.ts --measure cms125 [--server http://localhost:8899/fhir] [--json]
 *
 * ## Why this is the check that changes what we can say
 *
 * Our MADiE gate is 410/410 across eight measures, and that is real external evidence — the expected
 * answers are CMS/measure-developer-authored. But **the execution is entirely ours**: one engine
 * (`fqm-execution`) reading one artifact. `fqm-testify` and `deqm-test-server` cannot help, because both
 * WRAP `fqm-execution` — comparing against them compares our engine to itself.
 *
 * `cqf-fhir-cr` (HAPI's Clinical Reasoning module) is a genuinely separate implementation: different CQL
 * engine, different FHIR data provider, different language. Running the same artifact over the same cases
 * in both and comparing turns *"our engine agrees with the expected answers"* into **"two independently
 * written engines agree with the expected answers, and with each other."** That is a strictly stronger
 * claim than the Cypress green ADR-058 retired, and unlike that one it is obtainable.
 *
 * ## The JVM is here on purpose, and only here
 *
 * ADR-008 retired the JVM from the product. This reintroduces it as a **dev-time oracle only** — a Docker
 * container the developer runs, never a runtime dependency, never a package dependency, never in CI. The
 * cost is stated rather than hidden: see ROADMAP_2026-08-04 §4.
 *
 *     docker run -d --name hapi-cr -p 8899:8080 \
 *       -e hapi.fhir.fhir_version=R4 -e hapi.fhir.cr.enabled=true \
 *       -e hapi.fhir.allow_external_references=true \
 *       -e hapi.fhir.enforce_referential_integrity_on_write=false \
 *       hapiproject/hapi:latest
 *
 * The property is `hapi.fhir.cr.enabled` — with `cr_enabled` the server starts fine and simply declares no
 * measure operations, which is a silent no-op rather than an error. Confirm before trusting a run:
 * `Measure` must list `evaluate-measure` in the CapabilityStatement.
 *
 * Then load the measure bundle, which is self-contained (Measure + Libraries + ValueSets + every test
 * patient + every expected MeasureReport, as one transaction):
 *
 *     curl -X POST http://localhost:8899/fhir -H "Content-Type: application/fhir+json" \
 *       --data-binary @.official-content/bundles/measure/<Name>/<Name>-bundle.json
 *
 * ## The degenerate-sweep refusal
 *
 * If EVERY case comes back with an all-zero population vector, that is **not** agreement even when some
 * expecteds are also all-zero — it is the signature of terminology or libraries failing to resolve, and
 * it would otherwise read as a clean run. Same hazard PR-8f's batch-level retrieve refusal exists for, and
 * the same one ADR-043 says is silent by nature. This REFUSES rather than reporting a false pass.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CMS122_KNOWN_BAD_EXPECTEDS, POPULATION_CODES, officialMeasureName } from "../src/standards/official-cases.ts";

const CONTENT = ".official-content";

type Counts = Partial<Record<(typeof POPULATION_CODES)[number], number>>;

interface CaseResult {
  case: string;
  patientId: string;
  expected: Counts;
  java: Counts | null;
  error?: string;
  agrees: boolean;
}

const countsOf = (report: { group?: Array<{ population?: Array<{ code?: { coding?: Array<{ code?: string }> }; count?: number }> }> }): Counts => {
  const out: Counts = {};
  for (const p of report.group?.[0]?.population ?? []) {
    const code = p.code?.coding?.[0]?.code as (typeof POPULATION_CODES)[number] | undefined;
    if (code && POPULATION_CODES.includes(code)) out[code] = p.count ?? 0;
  }
  return out;
};

/** Compare on the populations the EXPECTED report declares — an engine may legitimately report more. */
const same = (expected: Counts, actual: Counts): boolean =>
  Object.entries(expected).every(([k, v]) => actual[k as keyof Counts] === v);

const allZero = (c: Counts): boolean => Object.values(c).every((v) => v === 0);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const measure = arg("--measure");
  const server = arg("--server") ?? "http://localhost:8899/fhir";
  if (!measure) {
    console.error("usage: tsx scripts/cross-engine-check.ts --measure <cms122|cms125|…> [--server URL] [--json]");
    process.exit(2);
  }
  const name = officialMeasureName(measure);
  if (!name) {
    console.error(`unknown measure '${measure}' — must be one of the gated official measures`);
    process.exit(2);
  }

  // Fail loudly if the server is not actually CR-enabled. Without this the sweep would run, every
  // evaluate would 404, and "0 agreements" would look like a catastrophic engine disagreement rather
  // than a misconfigured container.
  const capability = (await (await fetch(`${server}/metadata`)).json()) as {
    rest?: Array<{ resource?: Array<{ type?: string; operation?: Array<{ name?: string }> }> }>;
  };
  const measureOps = capability.rest
    ?.flatMap((r) => r.resource ?? [])
    .find((r) => r.type === "Measure")
    ?.operation?.map((o) => o.name) ?? [];
  if (!measureOps.includes("evaluate-measure")) {
    console.error(
      `FAIL: ${server} declares no Measure/$evaluate-measure.\n` +
        `The CR module is off — check 'hapi.fhir.cr.enabled=true' (NOT 'cr_enabled', which is a silent no-op).`,
    );
    process.exit(1);
  }

  // `--load-terminology` replaces the server's ValueSet expansions with OUR completed ones
  // (ADR-041's `terminology.json` sidecar), so both engines read the SAME codes. Without it the
  // upstream bundle's capped expansions are in play and any disagreement is ambiguous between
  // "different engine" and "different terminology" — which is not a comparison of engines at all.
  if (argv.includes("--load-terminology")) {
    const sidecarPath = join("measures", "official", measure, "terminology.json");
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
      valueSets: Array<{ url: string; codes: Array<{ system: string; code: string }> }>;
    };
    let replaced = 0;
    for (const vs of sidecar.valueSets) {
      const found = (await (await fetch(`${server}/ValueSet?url=${encodeURIComponent(vs.url)}`)).json()) as {
        entry?: Array<{ resource: Record<string, unknown> }>;
      };
      const existing = found.entry?.[0]?.resource;
      if (!existing) continue;
      const body = {
        ...existing,
        expansion: {
          timestamp: "2026-01-01T00:00:00Z",
          total: vs.codes.length,
          contains: vs.codes.map((c) => ({ system: c.system, code: c.code })),
        },
      };
      const put = await fetch(`${server}/ValueSet/${String(existing.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/fhir+json" },
        body: JSON.stringify(body),
      });
      if (put.ok) replaced++;
    }
    console.log(`loaded completed terminology: ${replaced}/${sidecar.valueSets.length} value sets replaced`);
    if (replaced === 0) {
      console.error("FAIL: no value sets were replaced — is the measure bundle loaded on this server?");
      process.exit(1);
    }
  }

  const testsDir = join(CONTENT, "input", "tests", "measure", name);
  const caseDirs = readdirSync(testsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

  const results: CaseResult[] = [];
  let period: { start: string; end: string } | undefined;

  for (const dir of caseDirs) {
    const files = readdirSync(join(testsDir, dir)).filter((f) => f.endsWith(".json"));
    const mrFile = files.find((f) => f.startsWith("MeasureReport-"));
    const ptFile = files.find((f) => f.startsWith("Patient-"));
    if (!mrFile || !ptFile) continue;
    const mr = JSON.parse(readFileSync(join(testsDir, dir, mrFile), "utf8")) as {
      group?: never; period?: { start: string; end: string };
    };
    const expected = countsOf(mr as never);
    period ??= mr.period;
    const patientId = (JSON.parse(readFileSync(join(testsDir, dir, ptFile), "utf8")) as { id: string }).id;

    const url =
      `${server}/Measure/${name}/$evaluate-measure` +
      `?subject=Patient/${patientId}&periodStart=${period?.start}&periodEnd=${period?.end}&reportType=subject`;
    try {
      const res = await fetch(url);
      const body = (await res.json()) as { resourceType?: string };
      if (body.resourceType !== "MeasureReport") {
        results.push({ case: dir, patientId, expected, java: null, error: `${res.status} ${body.resourceType}`, agrees: false });
        continue;
      }
      const java = countsOf(body as never);
      results.push({ case: dir, patientId, expected, java, agrees: same(expected, java) });
    } catch (e) {
      results.push({ case: dir, patientId, expected, java: null, error: String(e), agrees: false });
    }
  }

  const evaluated = results.filter((r) => r.java !== null);
  const agreed = results.filter((r) => r.agrees);
  const known = measure === "cms122" ? CMS122_KNOWN_BAD_EXPECTEDS : new Set<string>();
  const unexpected = results.filter((r) => !r.agrees && !known.has(r.case));

  // The degenerate-sweep refusal — see the header. An all-zero sweep is a resolution failure wearing
  // agreement's clothes.
  if (evaluated.length > 0 && evaluated.every((r) => allZero(r.java!))) {
    console.error(
      `\nFAIL: every one of ${evaluated.length} evaluated cases returned an all-zero population vector.\n` +
        `That is the signature of terminology or libraries failing to resolve, NOT agreement. Confirm the\n` +
        `measure bundle loaded (Measure + Libraries + ValueSets) before believing any number from this run.`,
    );
    process.exit(1);
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ measure, name, server, period, results }, null, 2));
    process.exit(unexpected.length === 0 ? 0 : 1);
  }

  console.log(`\nmeasure       : ${measure} (${name})`);
  console.log(`engine        : cqf-fhir-cr via ${server}`);
  console.log(`period        : ${period?.start} .. ${period?.end}`);
  console.log(`cases         : ${results.length}  (evaluated ${evaluated.length})`);
  console.log(`agreeing      : ${agreed.length}/${results.length}`);
  if (known.size) console.log(`known-bad     : ${known.size} expecteds upstream itself flags as wrong`);
  console.log(`UNEXPECTED    : ${unexpected.length}`);
  for (const r of unexpected.slice(0, 20)) {
    console.log(`  - ${r.case}${r.error ? ` ERROR ${r.error}` : ""}`);
    if (r.java) {
      console.log(`      expected ${JSON.stringify(r.expected)}`);
      console.log(`      java     ${JSON.stringify(r.java)}`);
    }
  }
  console.log(
    unexpected.length === 0
      ? `\n=== ${agreed.length}/${results.length} — the Java engine agrees with every expected result ===`
      : `\n=== ${unexpected.length} unexpected disagreement(s) — each needs a cause, not a re-run ===`,
  );
  process.exit(unexpected.length === 0 ? 0 : 1);
}

await main();
