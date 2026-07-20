#!/usr/bin/env -S npx tsx
/**
 * ingest-cli — `npm run ingest -- --file patients.yaml [--dry-run | --rollback]`
 *
 * The Doug demo loop, write side: AI-generated YAML patients → the WebChart dev DB. Every touched
 * field is validated against WebChart's `model` schema catalog (existence + declared type) before
 * any write; all writes run in one transaction. DEV DATABASE ONLY — the CLI refuses non-local /
 * non-wcdb-looking targets unless WCDB_INGEST_UNSAFE_TARGET_OK=1 is set explicitly.
 *
 * Ingest writes a MANIFEST (`<file>.ingested.json`) recording exactly the pat_ids it created;
 * `--rollback` deletes exactly those (natural-key re-verified) and refuses to run without the
 * manifest. Every ingest/rollback appends a JSON line to `ingest-audit.log` (package root) —
 * who/when/where/what, the dev-tool's durable audit trail.
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { configFromEnv, createDb, type DbConfig } from "./db.ts";
import { ingest, parseIngestYaml, rollback, type IngestManifest } from "./ingest.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const AUDIT_LOG = fileURLToPath(new URL("../ingest-audit.log", import.meta.url));

function audit(op: string, cfg: DbConfig, file: string, detail: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    op,
    actor: userInfo().username,
    target: { host: cfg.host, port: cfg.port, database: cfg.database },
    file,
    ...detail,
  });
  appendFileSync(AUDIT_LOG, line + "\n", "utf8");
}

/** Dev-database-only contract, enforced: local host + a wc_-prefixed database, or explicit opt-out. */
function assertDevTarget(cfg: DbConfig): void {
  if (process.env.WCDB_INGEST_UNSAFE_TARGET_OK === "1") return;
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const problems: string[] = [];
  if (!localHosts.has(cfg.host)) problems.push(`host '${cfg.host}' is not local`);
  if (!cfg.database.startsWith("wc_")) problems.push(`database '${cfg.database}' does not look like a WebChart dev DB`);
  if (problems.length) {
    throw new Error(
      `refusing to write: ${problems.join("; ")}. This tool mutates patient rows and is for the ` +
        `synthetic dev-wcdb ONLY. If you are certain the target is a disposable dev database, ` +
        `set WCDB_INGEST_UNSAFE_TARGET_OK=1.`,
    );
  }
}

function readManifest(path: string): IngestManifest | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as IngestManifest;
}

async function main(): Promise<number> {
  const file = arg("file");
  if (!file) {
    console.error("usage: npm run ingest -- --file <patients.yaml> [--dry-run | --rollback]");
    return 2;
  }
  if (has("dry-run") && has("rollback")) {
    console.error("--dry-run and --rollback are mutually exclusive (rollback has no dry-run mode; it deletes exactly the manifest's rows)");
    return 2;
  }
  const manifestPath = `${file}.ingested.json`;
  const cfg = configFromEnv();
  const dryRun = has("dry-run");
  if (!dryRun) assertDevTarget(cfg); // dry-run only reads; both write paths are guarded
  const db = createDb(cfg);
  try {
    if (has("rollback")) {
      const manifest = readManifest(manifestPath);
      if (!manifest) {
        console.error(
          `no manifest at ${manifestPath} — rollback deletes ONLY rows recorded by a prior ingest ` +
            `of this file (never by name search, so a pre-existing WebChart patient can't be hit). ` +
            `If the manifest was lost, remove the rows manually by pat_id.`,
        );
        return 2;
      }
      const rep = await rollback(db, manifest);
      for (const r of rep.removed) console.log(`  removed    ${r}`);
      for (const r of rep.notFound) console.log(`  absent     ${r}`);
      for (const r of rep.mismatched) console.log(`  MISMATCH   ${r}`);
      audit("rollback", cfg, file, {
        removed: rep.removed.length,
        absent: rep.notFound.length,
        mismatched: rep.mismatched.length,
      });
      if (rep.mismatched.length === 0) {
        unlinkSync(manifestPath); // fully unwound — the manifest has served its purpose
      } else {
        console.error(`manifest kept at ${manifestPath} — ${rep.mismatched.length} row(s) refused (see MISMATCH above)`);
      }
      console.log(`rollback: ${rep.removed.length} removed, ${rep.notFound.length} already absent, ${rep.mismatched.length} refused`);
      return rep.mismatched.length ? 1 : 0;
    }

    const doc = parseIngestYaml(readFileSync(file, "utf8"));
    const rep = await ingest(db, doc, { dryRun });
    console.log(`  ${rep.modelValidation}`);
    for (const s of rep.skippedExisting) console.log(`  skipped  ${s}`);
    for (const i of rep.inserted) console.log(`  ${rep.dryRun ? "would insert" : "inserted"} ${i.subjectId}  ${i.name}  (${i.observations} observation(s))`);
    if (!rep.dryRun && rep.created.length) {
      const prior = readManifest(manifestPath);
      const manifest: IngestManifest = {
        createdAt: new Date().toISOString(),
        database: `${cfg.host}:${cfg.port}/${cfg.database}`,
        created: [...(prior?.created ?? []), ...rep.created],
      };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      console.log(`  manifest → ${manifestPath} (${manifest.created.length} row(s); required for --rollback)`);
    }
    if (!rep.dryRun) {
      audit("ingest", cfg, file, {
        inserted: rep.created.map((c) => c.patId),
        skippedExisting: rep.skippedExisting.length,
      });
    }
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
