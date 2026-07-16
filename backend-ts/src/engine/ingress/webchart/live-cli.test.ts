/**
 * CI tests for the live-evaluate CLI (`evaluate:webchart-live`) — arg parsing, the fail-fast
 * config gate, and an end-to-end run over an injected fixture client (no HTTP; the real-HTTP
 * proof lives in `hapi-live.test.ts`, self-skipping).
 *   node --import tsx --test src/engine/ingress/webchart/live-cli.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runLiveCli } from "./live-cli.ts";
import { fixtureWebChartClient } from "./webchart-client.ts";

const ENV = { WORKWELL_WEBCHART_BASE_URL: "http://example.test", WORKWELL_WEBCHART_API_KEY: "k" };

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) },
  };
}

const patientBundle = (id: string, extras: unknown[] = []) => ({
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { resource: { resourceType: "Patient", id, name: [{ given: ["Pat"], family: id.toUpperCase() }], gender: "female", birthDate: "1980-01-01" } },
    ...extras.map((resource) => ({ resource })),
  ],
});

test("unconfigured env fails fast (exit 2) and never falls back to the JSON source", async () => {
  const { io, err } = capture();
  const code = await runLiveCli([], { env: {}, ...io });
  assert.equal(code, 2);
  assert.match(err.join(""), /not configured/);
});

test("bad arguments exit 2: malformed date, unknown measure, missing roster value, bad page size", async () => {
  for (const argv of [
    ["--date", "2024-13-45"],
    ["--measures", "not_a_measure"],
    ["--roster"],
    ["--page-size", "0"],
    ["--frobnicate"],
  ]) {
    const { io } = capture();
    assert.equal(await runLiveCli(argv, { env: ENV, ...io }), 2, `argv: ${argv.join(" ")}`);
  }
});

test("evaluation without --roster is refused with guidance", async () => {
  const { io, err } = capture();
  const code = await runLiveCli([], { env: ENV, client: fixtureWebChartClient([]), ...io });
  assert.equal(code, 2);
  assert.match(err.join(""), /--roster is required/);
});

test("--list-patients: roster template JSON on stdout (pre-filled with selected measures), table on stderr", async () => {
  const { io, out, err } = capture();
  const client = fixtureWebChartClient([patientBundle("wc-1"), patientBundle("wc-2")]);
  const code = await runLiveCli(["--list-patients", "--measures", "diabetes_hba1c"], { env: ENV, client, ...io });
  assert.equal(code, 0);
  const template = JSON.parse(out.join(""));
  assert.deepEqual(template, { "wc-1": ["diabetes_hba1c"], "wc-2": ["diabetes_hba1c"] });
  const table = err.join("");
  assert.match(table, /2 patients/);
  assert.match(table, /Pat WC-1/);
});

test("end-to-end: injected fixture client + roster file → per-measure outcome table", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-cli-"));
  const rosterPath = path.join(dir, "roster.json");
  writeFileSync(rosterPath, JSON.stringify({ "wc-1": ["diabetes_hba1c"] }));
  // an in-window HbA1c (real LOINC → crosswalk) so the enrolled subject evaluates non-MISSING
  const hba1c = {
    resourceType: "Observation",
    status: "final",
    subject: { reference: "Patient/wc-1" },
    code: { coding: [{ system: "http://loinc.org", code: "4548-4" }] },
    effectiveDateTime: "2024-05-01",
    valueQuantity: { value: 6.8, unit: "%" },
  };
  const client = fixtureWebChartClient([patientBundle("wc-1", [hba1c]), patientBundle("wc-2")]);
  const { io, out } = capture();
  const code = await runLiveCli(
    ["--roster", rosterPath, "--measures", "diabetes_hba1c", "--date", "2024-06-01"],
    { env: ENV, client, ...io },
  );
  assert.equal(code, 0);
  const report = out.join("");
  assert.match(report, /WebChart LIVE evaluation — 2 patients from example.test/);
  assert.match(report, /diabetes_hba1c/);
  // wc-1 is enrolled + has a recent result → 1 non-MISSING outcome; wc-2 unenrolled → MISSING_DATA
  assert.match(report, /→ 1 real \(non-MISSING_DATA\) outcomes across 1 measures\./);
});

test("--date defaults to the injected today (live data is contemporaneous)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-cli-"));
  const rosterPath = path.join(dir, "roster.json");
  writeFileSync(rosterPath, JSON.stringify({}));
  const client = fixtureWebChartClient([patientBundle("wc-1")]);
  const { io, out } = capture();
  const code = await runLiveCli(["--roster", rosterPath], { env: ENV, client, today: "2026-01-02", ...io });
  assert.equal(code, 0);
  assert.match(out.join(""), /as-of 2026-01-02/);
});

test("a transport failure exits 1 with the host named (never a stack-trace-free silent zero)", async () => {
  const failing = { kind: "boom", fetchPatientPayloads: () => Promise.reject(new Error("connect ECONNREFUSED")) };
  const { io, err } = capture();
  const code = await runLiveCli(["--list-patients"], { env: ENV, client: failing, ...io });
  assert.equal(code, 1);
  assert.match(err.join(""), /live fetch failed against example.test: connect ECONNREFUSED/);
});
