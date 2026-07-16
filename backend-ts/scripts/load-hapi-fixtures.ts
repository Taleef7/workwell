/**
 * `pnpm load:hapi` — load the committed WebChart dev-DB fixtures into a local HAPI FHIR R4 server
 * (the "fake WebChart" simulator, ADR-032; Doug-suggested 2026-07-15).
 *
 *   pnpm load:hapi [--target http://localhost:8081/fhir] [--file spike/webchart/devdb-patients.json]
 *
 * Start the server first: `docker compose -f ../infra/docker-compose.yml up -d hapi-fhir`.
 * Idempotent: every entry is a `PUT {type}/{id}` with deterministic ids (see `hapi-transform.ts`),
 * so a re-run updates in place (HTTP 200) instead of duplicating (a duplicate Immunization would
 * double-count doses). Dev-only offline tool — never the request path, no DB, no new deps
 * (global `fetch`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { toTransactionBundles } from "../src/engine/ingress/webchart/hapi-transform.ts";

const USAGE = "usage: load:hapi [--target <fhir-base-url>] [--file <fixtures.json>]\n";
const DEFAULT_TARGET = "http://localhost:8081/fhir";
const BACKEND_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_FILE = path.join(BACKEND_ROOT, "spike", "webchart", "devdb-patients.json");

interface TxResponseEntry {
  response?: { status?: string };
}

async function main(argv: string[]): Promise<number> {
  let target = DEFAULT_TARGET;
  let file = DEFAULT_FILE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") {
      const v = argv[++i];
      if (!v) return usageError();
      target = v.replace(/\/+$/, "");
    } else if (arg === "--file") {
      const v = argv[++i];
      if (!v) return usageError();
      file = path.isAbsolute(v) ? v : path.join(BACKEND_ROOT, v);
    } else {
      process.stderr.write(`unrecognized argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }

  const bundles = toTransactionBundles(JSON.parse(readFileSync(file, "utf8")));
  process.stdout.write(`loading ${bundles.length} patient bundles into ${target} …\n`);

  let created = 0;
  let updated = 0;
  let resources = 0;
  for (const [i, tx] of bundles.entries()) {
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/fhir+json", Accept: "application/fhir+json" },
      body: JSON.stringify(tx),
    });
    const body = (await res.json().catch(() => undefined)) as
      | { resourceType?: string; type?: string; entry?: TxResponseEntry[] }
      | undefined;
    if (!res.ok || body?.resourceType !== "Bundle" || body.type !== "transaction-response") {
      process.stderr.write(
        `bundle ${i} (${tx.entry[0]?.request.url}) failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 500)}\n`,
      );
      return 1;
    }
    for (const entry of body.entry ?? []) {
      const status = entry.response?.status ?? "";
      if (!/^2\d\d/.test(status)) {
        process.stderr.write(`bundle ${i}: entry rejected with status "${status}"\n`);
        return 1;
      }
      resources++;
      if (status.startsWith("201")) created++;
      else updated++;
    }
  }

  process.stdout.write(
    `done: ${bundles.length} patients, ${resources} resources (${created} created, ${updated} updated).\n` +
      `verify: curl "${target}/Patient?_summary=count"\n`,
  );
  return 0;
}

function usageError(): number {
  process.stderr.write(USAGE);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
