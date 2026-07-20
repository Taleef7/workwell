#!/usr/bin/env -S npx tsx
/**
 * ingest-cli — `npm run ingest -- --file patients.yaml [--dry-run | --rollback]`
 *
 * The Doug demo loop, write side: AI-generated YAML patients → the WebChart dev DB. Every touched
 * field is validated against WebChart's `model` schema catalog before any write; `--rollback`
 * reverses exactly the file's patients. DEV DATABASE ONLY.
 */
import { readFileSync } from "node:fs";
import { configFromEnv, createDb } from "./db.ts";
import { ingest, parseIngestYaml, rollback } from "./ingest.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  const file = arg("file");
  if (!file) {
    console.error("usage: npm run ingest -- --file <patients.yaml> [--dry-run | --rollback]");
    return 2;
  }
  const doc = parseIngestYaml(readFileSync(file, "utf8"));
  const db = createDb(configFromEnv());
  try {
    if (has("rollback")) {
      const rep = await rollback(db, doc);
      for (const r of rep.removed) console.log(`  removed  ${r}`);
      for (const r of rep.notFound) console.log(`  absent   ${r}`);
      console.log(`rollback: ${rep.removed.length} removed, ${rep.notFound.length} not present`);
      return 0;
    }
    const rep = await ingest(db, doc, { dryRun: has("dry-run") });
    console.log(`  ${rep.modelValidation}`);
    for (const s of rep.skippedExisting) console.log(`  skipped  ${s}`);
    for (const i of rep.inserted) console.log(`  ${rep.dryRun ? "would insert" : "inserted"} ${i.subjectId}  ${i.name}  (${i.observations} observation(s))`);
    console.log(
      rep.dryRun
        ? `dry-run: ${rep.inserted.length} patient(s) would be inserted, ${rep.skippedExisting.length} already present`
        : `ingested ${rep.inserted.length} patient(s) (${rep.skippedExisting.length} already present) — the shim/CQL/SQL/dashboards pick them up immediately`,
    );
    return 0;
  } finally {
    await db.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
