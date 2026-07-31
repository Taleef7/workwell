#!/usr/bin/env node
/**
 * Does an upstream measure bundle ship every value set its ELM retrieves? (ADR-053)
 *
 *   pnpm official:terminology-audit                        # every measure in .official-content
 *   pnpm official:terminology-audit CMS138FHIRTobaccoScrnCessation
 *
 * ## Why this is a command and not a paragraph
 *
 * ADR-047 recorded CMS138's failure as *"value set …3.526.3.1278 will not expand"*. That sentence is a
 * symptom, and it points at the wrong system: it reads as a failure of our expander, our sidecar or our
 * VSAC pin. The actual condition is that upstream's bundle carries no ValueSet resource for the OID —
 * which no amount of re-vendoring at the same pin can fix, and which is invisible to `vendor:official`
 * because that script enumerates the value sets a bundle SHIPS.
 *
 * Running this against all six sparse-checked-out measures produces the fact in one line each, and it
 * is the fact rather than the prose that belongs in an ADR:
 *
 *     CMS122FHIRDiabetesAssessGT9Pct    26 retrieved   26 shipped   OK
 *     CMS125FHIRBreastCancerScreen      32 retrieved   32 shipped   OK
 *     CMS138FHIRTobaccoScrnCessation    32 retrieved   31 shipped   1 ABSENT
 *       ABSENT 2.16.840.1.113883.3.526.3.1278  "Tobacco Use Screening"
 *     …
 *
 * ## Deliberately NOT in CI, and deliberately not a gate
 *
 * It reads `.official-content/` — a gitignored sparse checkout that only exists after
 * `fetch-official-cases.ps1` has run — so wiring it into `pnpm test` would produce the self-skipping
 * shape this project keeps finding in its own guards. The enforcement for VENDORED artifacts lives
 * where it can actually run: `absentValueSets` + `officialRoutingProblems`, against the artifact's own
 * two files, with no checkout required. This tool is for measures we are CONSIDERING — the ones with no
 * artifact to check yet, which is precisely when the answer changes what you do next.
 *
 * Exit code is 0 whatever it finds. It is a measurement, and a measurement that fails the build is a
 * gate wearing a measurement's name.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { declaredValueSets } from "./vsac-expansion.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTENT = resolve(HERE, "..", ".official-content", "bundles", "measure");

/** `http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840...` → `2.16.840...`. Mirrors the vendor script. */
const oidFromValueSetUrl = (url) => {
  const marker = "/ValueSet/";
  return url.includes(marker) ? url.slice(url.lastIndexOf(marker) + marker.length) : url;
};

if (!existsSync(CONTENT)) {
  console.error(
    `no upstream content at ${CONTENT}\n` +
      "Run `pwsh scripts/fetch-official-cases.ps1` first — it maintains the sparse checkout this reads.",
  );
  // Not a failure of the thing being measured, so not a failing exit either; but the caller asked a
  // question that cannot be answered, and saying so on stderr with a non-zero code is the honest shape
  // for "I could not run" as distinct from "I ran and found nothing".
  process.exit(2);
}

const wanted = process.argv.slice(2);
const measures = readdirSync(CONTENT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => wanted.length === 0 || wanted.includes(name))
  .sort();

if (measures.length === 0) {
  console.error(`no measure directories matched ${wanted.join(", ") || "(all)"} under ${CONTENT}`);
  process.exit(2);
}

let anyAbsent = 0;
for (const measure of measures) {
  const path = join(CONTENT, measure, `${measure}-bundle.json`);
  if (!existsSync(path)) {
    console.log(`${measure.padEnd(34)} (no bundle file)`);
    continue;
  }
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // A measure whose bundle will not parse is a real finding, not a reason to abandon the other five.
    console.log(`${measure.padEnd(34)} UNREADABLE — ${err.message}`);
    continue;
  }
  const shipped = new Set();
  for (const entry of bundle.entry ?? []) {
    const resource = entry?.resource;
    if (resource?.resourceType !== "ValueSet") continue;
    shipped.add(oidFromValueSetUrl(resource.url ?? resource.id ?? ""));
  }
  // The same one-directional diff `collectTerminology` makes: a value set SHIPPED but never retrieved
  // is not a problem (upstream bundles carry dependency closures), so only the other direction counts.
  const retrieved = declaredValueSets(bundle).map((v) => ({ ...v, oid: oidFromValueSetUrl(v.url) }));
  const absent = retrieved.filter((v) => !shipped.has(v.oid));
  anyAbsent += absent.length;
  console.log(
    `${measure.padEnd(34)} ${String(retrieved.length).padStart(3)} retrieved  ` +
      `${String(shipped.size).padStart(3)} shipped   ${absent.length === 0 ? "OK" : `${absent.length} ABSENT`}`,
  );
  for (const gap of absent) console.log(`  ABSENT ${gap.oid}${gap.name ? `  "${gap.name}"` : ""}`);
}

if (anyAbsent > 0) {
  console.log(
    `\n${anyAbsent} value set(s) are retrieved but not shipped. Such a measure CANNOT be vendored into a` +
      " runnable artifact at this pin — source them from VSAC with `pnpm vendor:official …" +
      " --complete-terminology` and WORKWELL_VSAC_API_KEY set (ADR-053).",
  );
}
