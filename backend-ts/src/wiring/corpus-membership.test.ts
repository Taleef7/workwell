/**
 * The contract that keeps the synthetic corpus answerable by the measure CMS actually publishes:
 * **every code the corpus stamps must be a member of the official artifact's own expansion of the value
 * set it is registered under.**
 *
 * This guards a bug that no measure test can catch, because it makes the measure tests pass.
 * `bundled-ecqm-expansions.ts` supplies both the code stamped on the synthetic resource AND the offline
 * expansion the authored CQL resolves — so a wrong code is wrong in both places at once, the authored
 * retrieve still matches, and every outcome is exactly as expected. Only an EXTERNAL authority
 * disagrees, and the artifact's own terminology (ADR-036) is that authority. When this first ran, 12 of
 * 24 codes failed.
 *
 * It lives in `wiring/` rather than beside the table it checks: the table is engine data, the artifacts
 * are app wiring, and `engine/` is the future `@workwell/measure-engine` package — a test inside it that
 * imported an artifact loader would not survive extraction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_CODE_VALUE_SETS,
  ECQM_CANONICAL_CODES,
  MAMMOGRAPHY_PROCEDURE_CODES,
  bundledEcqmValueSetResolver,
} from "../engine/cql/bundled-ecqm-expansions.ts";
import { loadOfficialArtifact } from "./official-artifacts.ts";
import { loadOfficialTerminology } from "./official-terminology.ts";

type CanonicalKey = keyof typeof CANONICAL_CODE_VALUE_SETS;
const canonical = (key: CanonicalKey) => ECQM_CANONICAL_CODES[key];

/** Union of both vendored artifacts' expansions: OID → member codes. */
function officialExpansions(): Map<string, ReadonlyArray<{ system: string; code: string }>> {
  const byOid = new Map<string, ReadonlyArray<{ system: string; code: string }>>();
  for (const catalogId of ["cms122", "cms125"]) {
    const artifact = loadOfficialArtifact(catalogId);
    if (!artifact) continue;
    const loaded = loadOfficialTerminology(artifact);
    if (!loaded.ok) continue;
    for (const [oid, codes] of loaded.codesByOid) if (!byOid.has(oid)) byOid.set(oid, codes);
  }
  return byOid;
}

const expansions = officialExpansions();
const skip = expansions.size > 0 ? false : "run 'pnpm vendor:official' to fetch the terminology sidecars";

test("every canonical code is a member of the official value set it is registered under", { skip }, () => {
  const failures: string[] = [];
  for (const [key, oid] of Object.entries(CANONICAL_CODE_VALUE_SETS) as [CanonicalKey, string][]) {
    const ours = canonical(key);
    const official = expansions.get(oid);
    // A value set neither artifact references cannot be checked. Reported as a failure rather than
    // skipped, because "checked and fine" is exactly the false reading this file exists to prevent.
    if (!official) {
      failures.push(`${key}: ${oid} is referenced by neither vendored artifact, so it went unchecked`);
      continue;
    }
    if (official.some((c) => c.code === ours.code && c.system === ours.system)) continue;
    failures.push(
      `${key}: ${ours.code} (${ours.system}) is not in ${oid} — ${official.length} members, e.g. ` +
        official.slice(0, 3).map((c) => c.code).join(", "),
    );
  }
  assert.deepEqual(failures, []);
});

test("no two canonical codes are registered under the same value set", () => {
  // One constant serving two value sets is how the old table went wrong: SNOMED 385763009 was written
  // for both "Hospice Encounter" and "Hospice Care Ambulatory", is a member of only the second, and so
  // read as correct from whichever side you checked.
  const byOid = new Map<string, string[]>();
  for (const [key, oid] of Object.entries(CANONICAL_CODE_VALUE_SETS)) {
    byOid.set(oid, [...(byOid.get(oid) ?? []), key]);
  }
  assert.deepEqual([...byOid].filter(([, keys]) => keys.length > 1), []);
});

test("the offline expansion serves the canonical code for every registered value set", async () => {
  // The membership test proves the TABLE is right; this proves the RESOLVER is built from it. Without
  // it the two could disagree, and the authored measures would resolve something unverified.
  for (const [key, oid] of Object.entries(CANONICAL_CODE_VALUE_SETS) as [CanonicalKey, string][]) {
    const ours = canonical(key);
    const expanded = await bundledEcqmValueSetResolver.expand(oid);
    assert.ok(
      expanded.some((c) => c.code === ours.code && c.system === ours.system),
      `${key}: offline expansion of ${oid} omits ${ours.code}`,
    );
  }
});

test("the mammography PROCEDURE codes stay outside the membership contract", { skip }, async () => {
  // CPT 77067 and HCPCS G0202 are what WebChart records and what the authored cms125 retrieves, and
  // neither is a member of VSAC's Mammography value set — that set is the Observation-flavoured LOINC
  // one, all 92 members. Pinning both halves keeps a future tidy-up from folding them into the canonical
  // table (where they would fail) or dropping them (silently breaking the authored path over real data).
  const oid = CANONICAL_CODE_VALUE_SETS.mammogram;
  // Not `!`. With only the cms122 sidecar fetched this test still runs (the skip needs BOTH absent),
  // and a non-null assertion would kill it with a TypeError instead of saying what is wrong.
  const official = expansions.get(oid);
  assert.ok(official, `${oid} is not in the fetched terminology — vendor cms125 before trusting this`);
  const offline = await bundledEcqmValueSetResolver.expand(oid);
  for (const procedureCode of MAMMOGRAPHY_PROCEDURE_CODES) {
    assert.ok(
      !official.some((c) => c.code === procedureCode.code),
      `${procedureCode.code} is now an official member — move it into ECQM_CANONICAL_CODES`,
    );
    assert.ok(
      offline.some((c) => c.code === procedureCode.code),
      `${procedureCode.code} dropped from the offline expansion — the authored cms125 retrieves it`,
    );
  }
});
