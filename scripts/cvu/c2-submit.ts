#!/usr/bin/env -S node --import tsx
/**
 * Drive the **whole §170.315(c)(2) loop through WorkWell's own API**, over a Cypress C2 patient archive,
 * and write the QRDA Category III a Calculation Check submission uploads.
 *
 *   corepack pnpm --dir backend-ts exec tsx ../scripts/cvu/c2-submit.ts \
 *     --docs ../cvu-workdir/c2/passB/CMS125v14 --measure cms125 --eval 2024-12-31 \
 *     --out ../cvu-workdir/c2/submission
 *
 * Unlike `c2-calculation-check.ts`, which calls the official executor directly to measure the
 * CALCULATION, this exercises the product: create a run → `POST /import` (documents resolved to people)
 * → `POST /finalize` → `GET /qrda`. The routes are driven in-process against a temporary SQLite
 * database, which is the same code path a deployed worker runs — no server, no fixtures, no shortcut
 * around identity resolution or the reportability guard.
 *
 * **The measurement period is the runtime's, not Cypress's.** `officialMeasurementPeriod` derives a
 * ROLLING window from the evaluation date (ADR-039), and no route accepts an explicit calendar period —
 * so passing `--eval 2024-12-31` evaluates `2023-12-31 … 2024-12-31` where Cypress computed its expected
 * results over `2024-01-01 … 2024-12-31`. Measured on both archives: **zero subjects move** between the
 * two windows (C2 evidence §14). That is a measurement about this corpus, not a general equivalence.
 *
 * Reference-only, like the rest of `scripts/cvu/`: not wired into CI, writes nothing outside `--out`.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { handleRuns } from "../../backend-ts/src/routes/runs.ts";

interface Args {
  docs: string;
  measure: string;
  evaluationDate: string;
  out: string;
  assertMeasureIdentifiers: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--docs") args.docs = argv[++i];
    else if (arg === "--measure") args.measure = argv[++i];
    else if (arg === "--eval") args.evaluationDate = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--assert-measure") (args.assertMeasureIdentifiers ??= []).push(argv[++i]!);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.docs || !args.measure || !args.evaluationDate || !args.out) {
    throw new Error("--docs, --measure, --eval and --out are all required");
  }
  args.assertMeasureIdentifiers ??= [];
  return args as Args;
}

/** Population counts as the Category III document itself reports them — parsed back out of the XML. */
function populationsFromQrda3(xml: string): Record<string, number> {
  const counts: Record<string, number> = {};
  // Each Measure Data observation names the population it counts and wraps an Aggregate Count.
  for (const block of xml.matchAll(/<observation[\s\S]*?<\/observation>/g)) {
    const population = /<value[^>]*code="(IPOP|IPP|DENOM|NUMER|DENEX|DENEXCEP|NUMEX)"/.exec(block[0])?.[1];
    const count = /<value[^>]*xsi:type="INT"[^>]*value="(\d+)"/.exec(block[0])?.[1];
    if (population && count) counts[population === "IPOP" ? "IPP" : population] = Number(count);
  }
  return counts;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const documents = readdirSync(args.docs)
    .filter((f) => f.endsWith(".xml"))
    .sort()
    .map((f) => readFileSync(join(args.docs, f), "utf8"));
  if (documents.length === 0) throw new Error(`no .xml documents in ${args.docs}`);

  // Official routing is the point: C2 grades our numbers against Cypress's, and CMS's published
  // artifacts are what we are claiming to run.
  const env = {
    DB: await createSqliteD1(join(tmpdir(), `workwell-c2-${crypto.randomUUID()}.sqlite`)),
    WORKWELL_OFFICIAL_MEASURES: args.measure,
  } as never;
  const post = (path: string, body?: unknown) =>
    handleRuns(new Request(`http://x${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined }), env);
  const get = (path: string) => handleRuns(new Request(`http://x${path}`, { method: "GET" }), env, "system");

  const created = await post("/api/runs", {
    scopeType: "MEASURE",
    scopeId: args.measure,
    triggeredBy: "cypress-c2",
    requestedScope: { measureId: args.measure, evaluationDate: args.evaluationDate },
    measurementPeriodStart: `${args.evaluationDate.slice(0, 4)}-01-01T00:00:00.000Z`,
    measurementPeriodEnd: `${args.evaluationDate}T23:59:59.999Z`,
  });
  const run = (await created!.json()) as { id: string };
  console.log(`run ${run.id}`);

  const imported = await post(`/api/runs/${run.id}/import`, {
    measureId: args.measure,
    evaluationDate: args.evaluationDate,
    qrda1: documents,
    // Cypress ships the QDM lineage of the same measure (`CMS125v14`), whose version-specific eMeasure
    // UUID our FHIR/QI-Core artifact knows nothing about. The route refuses that by default and takes an
    // explicit assertion instead, which it records with every outcome — see `--assert-measure`.
    assertMeasureIdentifiers: args.assertMeasureIdentifiers,
  });
  const importBody = (await imported!.json()) as Record<string, any>;
  if (imported!.status !== 201) throw new Error(`import failed ${imported!.status}: ${JSON.stringify(importBody)}`);
  console.log(
    `import: ${importBody.documents} documents → ${importBody.subjects} subjects ` +
      `(${importBody.merged.length} merged, ${importBody.importFailures.length} unreadable, ` +
      `${importBody.evaluationFailures.length} evaluation failures, ` +
      `${importBody.demographicConflicts.length} demographic conflicts)`,
  );
  for (const failure of importBody.importFailures) console.log(`  unreadable[${failure.index}]: ${failure.message}`);
  for (const failure of importBody.evaluationFailures) console.log(`  eval ${failure.subjectId}: ${failure.message}`);

  const finalized = await post(`/api/runs/${run.id}/finalize`);
  const finalBody = (await finalized!.json()) as Record<string, any>;
  if (finalized!.status !== 200) throw new Error(`finalize failed ${finalized!.status}: ${JSON.stringify(finalBody)}`);
  console.log(`finalize: ${finalBody.status}`);

  const qrda3 = await get(`/api/runs/${run.id}/qrda`);
  if (qrda3!.status !== 200) throw new Error(`qrda3 export failed ${qrda3!.status}: ${await qrda3!.text()}`);
  const xml = await qrda3!.text();
  mkdirSync(args.out, { recursive: true });
  const path = join(args.out, `${args.measure}-qrda3.xml`);
  writeFileSync(path, xml);
  console.log(`wrote ${path} (${xml.length} bytes)`);
  console.log(`populations in the submitted document: ${JSON.stringify(populationsFromQrda3(xml))}`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
