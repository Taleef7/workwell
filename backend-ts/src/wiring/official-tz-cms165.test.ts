/**
 * The real CMS165 measure gives the same answer on a +9 host as on UTC, once the process is pinned (#845).
 *
 * CMS's own test case 048a7212 (vendored, hash-checked) has its hypertension onset changed to the date-only
 * `2026-06-30`. CMS165's initial population needs that diagnosis to overlap
 * `[start of the period, start + 6 months)`, and a date-only value takes the host's offset in cql-exec-fhir:
 * - under UTC the onset is uncertain against the window's end, so the patient is out;
 * - under Asia/Tokyo it is certainly before it, so the patient is in.
 *
 * Both arms run in a child process with `TZ=Asia/Tokyo`. The pinned arm must give UTC's answer. The
 * unpinned arm is the control that proves this case is sensitive to the zone at all.
 *
 * Needs cms165's terminology sidecar, so it self-skips without it and runs in CI's credentialed job.
 *
 *   node --import tsx --test src/wiring/official-tz-cms165.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOfficialArtifact } from "./official-artifacts.ts";
import { loadOfficialTerminology } from "./official-terminology.ts";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CASE_DIR = join(backendRoot, "measures/official/cms165/tests/048a7212-c19c-4f9d-89e2-13727b23e585");

const artifact = loadOfficialArtifact("cms165");
const missing = artifact && loadOfficialTerminology(artifact).ok ? null : "run 'pnpm vendor:official' to fetch cms165's terminology sidecar";
// In CI's credentialed job a missing sidecar is a failure, not a green skip (the same rule as its neighbours).
if (missing && process.env.WORKWELL_REQUIRE_OFFICIAL_TERMINOLOGY === "true") {
  test("#845 CMS165 time zone: terminology is required in this context", () => {
    throw new Error(missing);
  });
}
const skip = missing ?? false;

function inInitialPopulationInTokyo(pinned: boolean): { hostOffsetMinutes: number; ipp: boolean } {
  const source = `
    ${pinned ? 'import "./src/engine/utc.ts";' : ""}
    import { readdirSync, readFileSync } from "node:fs";
    import { loadOfficialArtifact } from "./src/wiring/official-artifacts.ts";
    import { officialTerminologyExpander } from "./src/wiring/official-terminology.ts";
    import { expandArtifactTerminology } from "./src/wiring/official-executor-adapter.ts";
    import { calculateOfficial, normalizePeriodEnd } from "@work-well/official-executor";
    const dir = process.env.CASE_DIR;
    const artifact = loadOfficialArtifact("cms165");
    const cache = await expandArtifactTerminology(artifact, officialTerminologyExpander(loadOfficialArtifact));
    const entry = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("MeasureReport")).map((f) => {
      const resource = JSON.parse(readFileSync(dir + "/" + f, "utf8"));
      if (resource.resourceType === "Condition") {
        delete resource.onsetPeriod;
        resource.onsetDateTime = "2026-06-30";
      }
      return { resource };
    });
    const patient = entry.find((e) => e.resource.resourceType === "Patient").resource.id;
    const result = await calculateOfficial({
      bundle: artifact.bundle,
      patientBundles: [{ resourceType: "Bundle", type: "collection", entry }],
      period: { start: "2026-01-01", end: normalizePeriodEnd("2026-12-31") },
      valueSetCache: cache,
      options: { trustMetaProfile: true },
    });
    console.log(JSON.stringify({
      hostOffsetMinutes: 0 - new Date().getTimezoneOffset(),
      ipp: result.get(patient)?.["initial-population"] === true,
    }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: backendRoot,
    env: { ...process.env, TZ: "Asia/Tokyo", CASE_DIR },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr.slice(-2000));
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
}

test("#845 control: unpinned on a +9 host, the date-only onset puts the patient IN the population", { skip }, () => {
  const out = inInitialPopulationInTokyo(false);
  assert.equal(out.hostOffsetMinutes, 540, "the child must really be at +9");
  assert.equal(out.ipp, true, "if this stops holding, the case no longer exercises the zone and the next test proves nothing");
});

test("#845: pinned, the same host gives UTC's answer (not in the population)", { skip }, () => {
  const out = inInitialPopulationInTokyo(true);
  assert.equal(out.hostOffsetMinutes, 0);
  assert.equal(out.ipp, false);
});
