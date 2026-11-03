/**
 * The practice's date (#882).
 *
 *   node --import tsx --test src/config/practice-date.test.ts
 *
 * The boundaries are the ones that matter on 31 December: in Hawaii the UTC date turns at 2 PM, in New
 * York at 7 PM. The sweep keeps "today" from being written as the UTC date again anywhere a run, a
 * re-check or a screen asks for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { practiceToday, practiceYear } from "./practice-date.ts";

test("Hawaii's year turns at 10:00 UTC on 1 January, not at midnight UTC", () => {
  assert.equal(practiceToday(new Date("2027-01-01T05:00:00.000Z"), "Pacific/Honolulu"), "2026-12-31");
  assert.equal(practiceToday(new Date("2027-01-01T09:59:59.999Z"), "Pacific/Honolulu"), "2026-12-31");
  assert.equal(practiceToday(new Date("2027-01-01T10:00:00.000Z"), "Pacific/Honolulu"), "2027-01-01");
  assert.equal(practiceYear(new Date("2027-01-01T09:59:59.999Z"), "Pacific/Honolulu"), 2026);
  assert.equal(practiceYear(new Date("2027-01-01T10:00:00.000Z"), "Pacific/Honolulu"), 2027);
});

test("New York's turns at 05:00 UTC", () => {
  assert.equal(practiceToday(new Date("2027-01-01T04:59:59.999Z"), "America/New_York"), "2026-12-31");
  assert.equal(practiceToday(new Date("2027-01-01T05:00:00.000Z"), "America/New_York"), "2027-01-01");
});

test("no zone, or one the runtime does not know, is UTC", () => {
  assert.equal(practiceToday(new Date("2027-01-01T00:00:00.000Z"), null), "2027-01-01");
  assert.equal(practiceToday(new Date("2026-12-31T23:59:59.999Z"), null), "2026-12-31");
  assert.equal(practiceToday(new Date("2027-01-01T00:00:00.000Z"), "Not/A_Zone"), "2027-01-01");
});

// ---- the sweep ----------------------------------------------------------------------------------

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Each one reads "today" as the UTC date. */
const UTC_TODAY = [
  /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/,
  /new Date\(\)\.getUTCFullYear\(\)/,
  /\bnow\.toISOString\(\)\.slice\(0,\s*10\)/,
  /\btoday\(\)\.toISOString\(\)\.slice\(0,\s*10\)/,
  /new Date\(\)\.toISOString\(\)\.split\(\s*"T"\s*\)/,
];

/**
 * Where the UTC date is right, by file. Seeding CLIs date what they write as the machine runs them; the
 * outcome diff's default is a pure function's, and every caller passes the year. The engine imports
 * nothing from the app (`engine-boundary.test.ts`), so its defaults stay UTC and the app passes the date.
 */
const ALLOWED: Record<string, string> = {
  "engine/ingress/evaluate-bundle.ts": "the engine's own default; the run pipeline passes the practice's date",
  "engine/ingress/webchart/live-cli.ts": "an engine developer CLI's default; --date sets it",
  "run/backfill-trend-history.ts": "a seeding CLI's default as-of",
  "run/backfill-quality-history.ts": "a seeding CLI's default as-of",
  "run/cli/seed-scale.ts": "a seeding CLI's default as-of",
  "run/cli/official-cases.ts": "a generated file's date stamp",
  "run/cli/official-flip-gate.ts": "a build-time gate CLI's default; --evaluation-date sets it",
  "standards/outcome-diff.ts": "a pure default; its callers pass the practice's year",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test-support" || name === "node_modules" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

test("no source file reads today as the UTC date outside the allow-list", () => {
  const offenders: string[] = [];
  for (const path of sourceFiles(SRC)) {
    const rel = relative(SRC, path).split(sep).join("/");
    if (rel in ALLOWED) continue;
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (UTC_TODAY.some((re) => re.test(line))) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(offenders, [], "use practiceToday()/practiceYear() from config/practice-date.ts");
});

test("every allow-listed file still holds a UTC today, so the list cannot outlive what it excuses", () => {
  for (const rel of Object.keys(ALLOWED)) {
    const text = readFileSync(join(SRC, rel), "utf8");
    assert.ok(UTC_TODAY.some((re) => re.test(text)), `${rel} no longer reads the UTC date; remove it from ALLOWED`);
  }
});
