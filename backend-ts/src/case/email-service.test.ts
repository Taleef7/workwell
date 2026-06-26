/**
 * Email provider tests (H2): simulated default + the inert SendGrid stub, env-selected.
 *   node --import tsx --test src/case/email-service.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulatedEmailService, sendgridEmailService, resolveEmailService } from "./email-service.ts";

test("simulatedEmailService returns a SIMULATED record (no real send)", () => {
  const r = simulatedEmailService.send("x@workwell-demo.dev", "Hi", "Body");
  assert.equal(r.provider, "simulated");
  assert.equal(r.status, "SIMULATED");
  assert.equal(r.errorDetail, null);
});

test("resolveEmailService: simulated by default (no provider / explicit simulated)", () => {
  assert.equal(resolveEmailService({}).send("a", "s", "b").provider, "simulated");
  assert.equal(resolveEmailService({ WORKWELL_EMAIL_PROVIDER: "simulated" }).send("a", "s", "b").provider, "simulated");
});

test("resolveEmailService: SendGrid stub ONLY when provider=sendgrid AND api key set", () => {
  const rec = resolveEmailService({ WORKWELL_EMAIL_PROVIDER: "sendgrid", WORKWELL_EMAIL_SENDGRID_API_KEY: "SG.key" }).send("a", "s", "b");
  assert.equal(rec.provider, "sendgrid");
  assert.equal(rec.status, "QUEUED"); // inert — never claims SENT
  assert.match(rec.errorDetail ?? "", /not yet wired/);
});

test("resolveEmailService: provider=sendgrid WITHOUT a key degrades to simulated", () => {
  assert.equal(resolveEmailService({ WORKWELL_EMAIL_PROVIDER: "sendgrid" }).send("a", "s", "b").provider, "simulated");
  // case-insensitive + whitespace-tolerant on the provider name, blank key still degrades
  assert.equal(resolveEmailService({ WORKWELL_EMAIL_PROVIDER: "SendGrid", WORKWELL_EMAIL_SENDGRID_API_KEY: "  " }).send("a", "s", "b").provider, "simulated");
});

test("sendgridEmailService is an inert stub (QUEUED, never SENT, no real HTTP)", () => {
  const rec = sendgridEmailService({ apiKey: "SG.key" }).send("a", "s", "b");
  assert.equal(rec.provider, "sendgrid");
  assert.equal(rec.status, "QUEUED");
});
