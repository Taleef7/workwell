/**
 * Inert-seam inventory tests (#260/#264): describeSeams flips each of the 8 seams on/off with the
 * correct env combination, preserving both-vars-required semantics where the underlying resolver
 * requires it (WebChart, DataChaser, ICE, EH-FHIR all need BOTH vars; SendGrid needs provider=sendgrid
 * AND a key; sql-executor is a single explicit opt-in; VSAC is a single key; alert-webhook is a single
 * URL).
 *   node --import tsx --test src/config/seam-inventory.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSeams, formatSeamLogLine, type SeamEnv } from "./seam-inventory.ts";

function statusOf(env: SeamEnv, name: string): boolean {
  const status = describeSeams(env).find((s) => s.name === name);
  assert.ok(status, `expected a seam named ${name}`);
  return status!.active;
}

test("describeSeams: everything off with no env vars set", () => {
  const seams = describeSeams({});
  assert.deepEqual(
    seams.map((s) => s.name),
    ["sendgrid", "datachaser", "ice", "eh-fhir", "webchart", "sql-executor", "vsac", "alert-webhook"],
  );
  for (const s of seams) assert.equal(s.active, false, `${s.name} should default off`);
});

test("formatSeamLogLine: all-off shape matches the documented boot log line", () => {
  assert.equal(
    formatSeamLogLine({}),
    "seams: sendgrid=off datachaser=off ice=off eh-fhir=off webchart=off sql-executor=off vsac=off alert-webhook=off",
  );
});

// ---- sendgrid: provider=sendgrid AND a key required ------------------------------------------------

test("sendgrid: off when provider is set without a key", () => {
  assert.equal(statusOf({ WORKWELL_EMAIL_PROVIDER: "sendgrid" }, "sendgrid"), false);
});

test("sendgrid: off when only the key is set (no provider=sendgrid)", () => {
  assert.equal(statusOf({ WORKWELL_EMAIL_SENDGRID_API_KEY: "SG.key" }, "sendgrid"), false);
});

test("sendgrid: on when provider=sendgrid AND a key are both set", () => {
  assert.equal(
    statusOf({ WORKWELL_EMAIL_PROVIDER: "sendgrid", WORKWELL_EMAIL_SENDGRID_API_KEY: "SG.key" }, "sendgrid"),
    true,
  );
});

// ---- datachaser: both API_KEY and BASE_URL required ------------------------------------------------

test("datachaser: off with only the api key", () => {
  assert.equal(statusOf({ WORKWELL_OUTREACH_DATACHASER_API_KEY: "k" }, "datachaser"), false);
});

test("datachaser: off with only the base url", () => {
  assert.equal(statusOf({ WORKWELL_OUTREACH_DATACHASER_BASE_URL: "https://dc.example" }, "datachaser"), false);
});

test("datachaser: on with both api key and base url", () => {
  assert.equal(
    statusOf(
      { WORKWELL_OUTREACH_DATACHASER_API_KEY: "k", WORKWELL_OUTREACH_DATACHASER_BASE_URL: "https://dc.example" },
      "datachaser",
    ),
    true,
  );
});

// ---- ice: BASE_URL alone selects (ADR-029 — a self-hosted sidecar has no API key) -----------------

test("ice: off with only the api key", () => {
  assert.equal(statusOf({ WORKWELL_IMMZ_ICE_API_KEY: "k" }, "ice"), false);
});

test("ice: ON with only the base url (the API key is optional)", () => {
  assert.equal(statusOf({ WORKWELL_IMMZ_ICE_BASE_URL: "https://ice.example" }, "ice"), true);
});

test("ice: on with both api key and base url", () => {
  assert.equal(
    statusOf({ WORKWELL_IMMZ_ICE_API_KEY: "k", WORKWELL_IMMZ_ICE_BASE_URL: "https://ice.example" }, "ice"),
    true,
  );
});

// ---- eh-fhir: both BASE_URL and API_KEY required ---------------------------------------------------

test("eh-fhir: off with only the base url", () => {
  assert.equal(statusOf({ WORKWELL_EH_FHIR_BASE_URL: "https://eh.example" }, "eh-fhir"), false);
});

test("eh-fhir: off with only the api key", () => {
  assert.equal(statusOf({ WORKWELL_EH_FHIR_API_KEY: "k" }, "eh-fhir"), false);
});

test("eh-fhir: on with both base url and api key", () => {
  assert.equal(
    statusOf({ WORKWELL_EH_FHIR_BASE_URL: "https://eh.example", WORKWELL_EH_FHIR_API_KEY: "k" }, "eh-fhir"),
    true,
  );
});

// ---- webchart: both BASE_URL and API_KEY required --------------------------------------------------

test("webchart: off with only the base url", () => {
  assert.equal(statusOf({ WORKWELL_WEBCHART_BASE_URL: "https://wc.example" }, "webchart"), false);
});

test("webchart: off with only the api key", () => {
  assert.equal(statusOf({ WORKWELL_WEBCHART_API_KEY: "k" }, "webchart"), false);
});

test("webchart: on with both base url and api key", () => {
  assert.equal(
    statusOf({ WORKWELL_WEBCHART_BASE_URL: "https://wc.example", WORKWELL_WEBCHART_API_KEY: "k" }, "webchart"),
    true,
  );
});

test("webchart: on with the SMART pair (CLIENT_ID + PRIVATE_KEY) and no api key (PR-2c)", () => {
  const PEM = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
  assert.equal(
    statusOf(
      { WORKWELL_WEBCHART_BASE_URL: "https://wc.example", WORKWELL_WEBCHART_CLIENT_ID: "c", WORKWELL_WEBCHART_PRIVATE_KEY: PEM },
      "webchart",
    ),
    true,
  );
});

test("webchart: off with only half the SMART pair", () => {
  assert.equal(
    statusOf({ WORKWELL_WEBCHART_BASE_URL: "https://wc.example", WORKWELL_WEBCHART_CLIENT_ID: "c" }, "webchart"),
    false,
  );
});

// ---- sql-executor: a single explicit opt-in --------------------------------------------------------

test("sql-executor: off for an unrelated/blank value", () => {
  assert.equal(statusOf({ WORKWELL_MEASURE_EXECUTOR: "" }, "sql-executor"), false);
  assert.equal(statusOf({ WORKWELL_MEASURE_EXECUTOR: "fhir-native" }, "sql-executor"), false);
});

test("sql-executor: on only for the exact opt-in value", () => {
  assert.equal(statusOf({ WORKWELL_MEASURE_EXECUTOR: "sql-pushdown" }, "sql-executor"), true);
});

// ---- vsac: a single key ------------------------------------------------------------------------

test("vsac: off with a blank/whitespace key", () => {
  assert.equal(statusOf({ WORKWELL_VSAC_API_KEY: "" }, "vsac"), false);
  assert.equal(statusOf({ WORKWELL_VSAC_API_KEY: "   " }, "vsac"), false);
});

test("vsac: on when the key is set (base url optional)", () => {
  assert.equal(statusOf({ WORKWELL_VSAC_API_KEY: "umls-key" }, "vsac"), true);
});

// ---- alert-webhook: a single URL (#264) -----------------------------------------------------------

test("alert-webhook: off with a blank/whitespace URL", () => {
  assert.equal(statusOf({ WORKWELL_ALERT_WEBHOOK_URL: "" }, "alert-webhook"), false);
  assert.equal(statusOf({ WORKWELL_ALERT_WEBHOOK_URL: "   " }, "alert-webhook"), false);
});

test("alert-webhook: on when WORKWELL_ALERT_WEBHOOK_URL is set", () => {
  assert.equal(statusOf({ WORKWELL_ALERT_WEBHOOK_URL: "https://hooks.example/alert" }, "alert-webhook"), true);
});

// ---- everything on at once, for the boot log line's full-on shape ---------------------------------

test("formatSeamLogLine: all-on shape when every seam is configured", () => {
  const allOn: SeamEnv = {
    WORKWELL_EMAIL_PROVIDER: "sendgrid",
    WORKWELL_EMAIL_SENDGRID_API_KEY: "SG.key",
    WORKWELL_OUTREACH_DATACHASER_API_KEY: "k",
    WORKWELL_OUTREACH_DATACHASER_BASE_URL: "https://dc.example",
    WORKWELL_IMMZ_ICE_API_KEY: "k",
    WORKWELL_IMMZ_ICE_BASE_URL: "https://ice.example",
    WORKWELL_EH_FHIR_BASE_URL: "https://eh.example",
    WORKWELL_EH_FHIR_API_KEY: "k",
    WORKWELL_WEBCHART_BASE_URL: "https://wc.example",
    WORKWELL_WEBCHART_API_KEY: "k",
    WORKWELL_MEASURE_EXECUTOR: "sql-pushdown",
    WORKWELL_VSAC_API_KEY: "umls-key",
    WORKWELL_ALERT_WEBHOOK_URL: "https://hooks.example/alert",
  };
  assert.equal(
    formatSeamLogLine(allOn),
    "seams: sendgrid=on datachaser=on ice=on eh-fhir=on webchart=on sql-executor=on vsac=on alert-webhook=on",
  );
});
