/**
 * The UTC pin does what it says: in a process started on a +9 host, importing it first makes a date-only
 * FHIR `dateTime` parse at offset 0, through the same cql-exec-fhir the official path runs (#845).
 *
 * Both arms run in a child process with `TZ=Asia/Tokyo`, because the test runner itself is pinned. The
 * unpinned arm is the control: without the pin the same parse takes +9, which is the bug (a CMS165
 * hypertension onset flipped in and out of the initial population with the host's zone).
 *
 *   node --import tsx --test src/engine/utc.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function onsetOffsetInTokyo(pinned: boolean): { tz: string | null; onsetOffset: number; hostOffsetMinutes: number } {
  const source = `
    ${pinned ? 'import "./src/engine/utc.ts";' : ""}
    import { loadCqlExecFhir } from "@work-well/official-executor";
    const fhir = await loadCqlExecFhir();
    const source = fhir.PatientSource.FHIRv401();
    source.loadBundles([{ resourceType: "Bundle", type: "collection", entry: [
      { resource: { resourceType: "Patient", id: "p" } },
      { resource: { resourceType: "Condition", id: "c", subject: { reference: "Patient/p" }, onsetDateTime: "2026-06-30" } },
    ] }]);
    const onset = source.currentPatient().findRecords("Condition")[0].get("onset").value;
    console.log(JSON.stringify({ tz: process.env.TZ ?? null, onsetOffset: onset.timezoneOffset, hostOffsetMinutes: 0 - new Date().getTimezoneOffset() }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: backendRoot,
    env: { ...process.env, TZ: "Asia/Tokyo" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
}

test("#845 control: without the pin, a +9 host gives a date-only onset offset +9", () => {
  const out = onsetOffsetInTokyo(false);
  assert.equal(out.hostOffsetMinutes, 540, "the child must really be at +9, or this test proves nothing");
  assert.equal(out.onsetOffset, 9);
});

test("#845: with the pin imported first, the same host gives offset 0", () => {
  const out = onsetOffsetInTokyo(true);
  assert.equal(out.tz, "UTC");
  assert.equal(out.hostOffsetMinutes, 0);
  assert.equal(out.onsetOffset, 0);
});
