/**
 * The credentialed vendor workflow must not leak licensed terminology, and must not gain write access.
 *
 * ## What this guards
 *
 * `vendor-official-measure.yml` runs `vendor:official` with `WORKWELL_VSAC_API_KEY_VENDOR` and uploads
 * the result as a downloadable artifact. Three files land in the output directory and only two of them
 * may leave the runner:
 *
 *   - `bundle.json`, `manifest.json` — already committed to this **public** repo. Counts, provenance,
 *     and the sidecar's SHA-256. No codes.
 *   - `terminology.json` — **thousands of AMA CPT and SNOMED CT codes under an NLM licence.** It is
 *     gitignored precisely so it is never redistributed (ADR-036). An artifact URL is redistribution.
 *
 * The difference between those outcomes is one `cp` line, or one `path:` that globs the directory
 * instead of naming files. That is exactly the kind of edit that gets made in a hurry to "just grab
 * everything", and it would be invisible in review — the artifact is a zip nobody opens.
 *
 * ## Why a text scan rather than a YAML parse
 *
 * No YAML parser is available (CLAUDE.md forbids new dependencies) and one is not needed: the property
 * is "the string `terminology.json` never appears in a step that copies or uploads", which a scan
 * answers directly. The same reason `official-flip-config.test.ts` reads its workflows as text.
 *
 * It runs unconditionally — no sidecar, no checkout, no network — so it cannot self-skip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKFLOW = fileURLToPath(
  new URL("../../../.github/workflows/vendor-official-measure.yml", import.meta.url),
);
const yaml = readFileSync(WORKFLOW, "utf8");

test("the vendor workflow exists and is dispatch-only", () => {
  // `workflow_dispatch` alone: no `push`, no `pull_request`. A credential-consuming job that ran on
  // every push would hit NLM on every commit, and would run on any branch a contributor could create.
  assert.match(yaml, /^on:\s*$/m);
  assert.match(yaml, /^\s{2}workflow_dispatch:/m);
  for (const trigger of ["push:", "pull_request:", "pull_request_target:", "schedule:"]) {
    assert.ok(!new RegExp(`^\\s{2}${trigger.replace(":", ":")}`, "m").test(yaml), `must not trigger on ${trigger}`);
  }
});

test("it never copies or uploads the licensed terminology sidecar", () => {
  // The load-bearing assertion. `terminology.json` may be MENTIONED in comments — the header explains
  // at length why it is excluded — so this checks the lines that move bytes, not the whole file.
  const moving = yaml
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .filter((line) => /\bcp\b|\bmv\b|\bcp -|path:|paths:|tar\b|zip\b/.test(line));
  assert.ok(moving.length > 0, "expected to find the copy/upload lines — if this is empty the scan is vacuous");
  for (const line of moving) {
    assert.ok(
      !line.includes("terminology.json"),
      `a step that moves bytes must never name terminology.json — it carries licensed codes (ADR-036): ${line.trim()}`,
    );
  }
});

test("the staged directory is populated by NAMED files, never a directory glob", () => {
  // A glob (`cp -r …/${id}/ …` or `cp …/*`) would sweep the sidecar in without ever naming it, so the
  // assertion above would pass while the artifact carried licensed codes. Both committable files must
  // be copied explicitly, and nothing may be copied by wildcard.
  const copies = yaml.split("\n").filter((l) => /^\s*cp\s/.test(l));
  assert.equal(copies.length, 2, `expected exactly two explicit cp lines, got ${copies.length}`);
  assert.ok(copies.some((l) => l.includes("bundle.json")), "bundle.json must be copied explicitly");
  assert.ok(copies.some((l) => l.includes("manifest.json")), "manifest.json must be copied explicitly");
  for (const line of copies) {
    assert.ok(!/[*?]/.test(line), `no wildcard may appear in a copy step: ${line.trim()}`);
    assert.ok(!/\s-r\b|\s-a\b|--recursive/.test(line), `no recursive copy may appear: ${line.trim()}`);
  }
});

test("it asks for read permissions only", () => {
  // It uploads an artifact for a human to review and commit. `contents: write` would make it a standing
  // ability to push to the repo, which is a much larger capability than the job needs.
  assert.match(yaml, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
  // Comment lines excluded, because the workflow's own header EXPLAINS why it does not take
  // `contents: write` — and the first cut of this test failed on that sentence. A guard that cannot
  // tell a prohibition from its own rationale is a guard that gets deleted rather than fixed.
  const effective = yaml.split("\n").filter((l) => !l.trim().startsWith("#"));
  assert.ok(
    !effective.some((l) => /contents:\s*write/.test(l)),
    "the vendor workflow must not request write access",
  );
});

test("it refuses to run without the credential rather than producing an incomplete artifact", () => {
  // Without the key the vendor script WARNS and leaves capped/absent value sets as upstream shipped
  // them. That is correct behaviour and exactly the artifact this workflow exists to avoid producing —
  // one that looks vendored and cannot be routed. Failing early is the difference between "no artifact"
  // and "an artifact someone commits".
  assert.match(yaml, /Refuse to run without the credential/);
  assert.match(yaml, /if \[ -z "\$WORKWELL_VSAC_API_KEY" \]/);
  assert.match(yaml, /exit 1/);
});

test("it passes --complete-terminology, which is the entire point of running it credentialed", () => {
  assert.match(yaml, /--complete-terminology/);
  assert.match(yaml, /--strip-elm-annotations/);
  assert.match(yaml, /WORKWELL_VSAC_API_KEY_VENDOR/);
});

test("no dispatch input is interpolated into a shell script (review, #365)", () => {
  // `${{ inputs.* }}` inside a `run:` block splices attacker-controlled text into the shell — and
  // command substitution executes inside double quotes, so `$(...)` in an input would run in a step
  // that holds the VSAC credential. Only write-access users can dispatch, which lowers the odds and
  // not the severity. Inputs go through `env:` and are validated first.
  //
  // Scanned line-by-line with a `run:`-block tracker rather than over the whole file, because
  // `env:` mappings and `with:` blocks legitimately carry `${{ inputs.* }}` — that IS the fix.
  const lines = yaml.split("\n");
  let inRun = false;
  let runIndent = 0;
  const offenders: string[] = [];
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (/^\s*(- )?run: \|/.test(line) || /^\s*run: \|/.test(line)) {
      inRun = true;
      runIndent = indent;
      continue;
    }
    // A `run:` block ends at the next key at or above its own indentation.
    if (inRun && line.trim() !== "" && indent <= runIndent && /^\s*[-\w]/.test(line)) inRun = false;
    if (inRun && /\$\{\{\s*inputs\./.test(line)) offenders.push(line.trim());
  }
  assert.deepEqual(offenders, [], "dispatch inputs must reach the shell via env:, never by interpolation");
  // Non-degeneracy: if the tracker never entered a run block, the loop above proves nothing.
  assert.ok(yaml.includes("run: |"), "expected multi-line run blocks to scan");
});

test("it REFUSES to upload an artifact whose terminology is still incomplete (review, #365)", () => {
  // `completeTerminology` fails closed and exits 0 — an expired key, an unreachable VSAC, a short
  // expansion or a wrong-OID echo all leave the terminology as upstream shipped it. So the vendor step
  // succeeding says nothing about whether the artifact is usable.
  //
  // The first cut checked only `manifest.terminology.truncated`, which an ABSENT value set never
  // appears in — so for CMS138, the measure this workflow was built for, the check was warning-free by
  // construction and the workflow would have uploaded exactly the unroutable artifact it claims to
  // reject. It must consult BOTH conditions, using the real runtime predicates.
  assert.match(yaml, /Verify the artifact is actually complete/);
  assert.match(yaml, /absentValueSets/, "must consult absent value sets, not only `truncated`");
  assert.match(yaml, /requiredOids/, "absentValueSets needs the ELM's declared canonicals");
  assert.match(yaml, /truncated\.length > 0 \|\| absent\.length > 0/, "both conditions must fail the job");

  // And it must come BEFORE the staging/upload steps, or it reports on an artifact already published.
  const verifyAt = yaml.indexOf("Verify the artifact is actually complete");
  const stageAt = yaml.indexOf("Stage the committable files only");
  const uploadAt = yaml.indexOf("upload-artifact");
  assert.ok(verifyAt > 0 && stageAt > verifyAt, "verification must precede staging");
  assert.ok(uploadAt > verifyAt, "verification must precede upload");
});
