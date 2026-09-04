/**
 * On the patient profile the outreach templates are code (`PATIENT_TEMPLATES`): list, preview and
 * dispatch all read them from there, so the admin write endpoints have nothing to persist. They must
 * say so — a "successful" update that the next list does not show (and an audit row for a change that
 * never happened) is worse than a refusal. The default profile keeps its store-backed CRUD.
 *
 *   node --import tsx --test src/admin/outreach-templates.maui.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const script = `
  import { createTemplate, updateTemplate, listTemplates, OutreachTemplateError, PATIENT_TEMPLATES_READ_ONLY } from "./src/admin/outreach-templates.ts";

  // A store that records writes; enough surface for create/update/list.
  const rows = new Map();
  const store = {
    writes: 0,
    async isEmpty() { return rows.size === 0; },
    async seed(t) { rows.set(t.id, { ...t, createdAt: "", updatedAt: "", active: true }); },
    async listActive() { return [...rows.values()].filter((r) => r.active); },
    async getById(id) { return rows.get(id) ?? null; },
    async create(t) { this.writes++; const r = { ...t, createdAt: "", updatedAt: "", active: true }; rows.set(t.id, r); return r; },
    async update(id, patch) { const r = rows.get(id); if (!r) return null; this.writes++; Object.assign(r, patch, { updatedAt: "now" }); return r; },
  };
  const audits = [];
  const events = { async appendAudit(e) { audits.push(e.eventType); } };

  // Seeding is not a create/update write; on maui the list ignores the store anyway.
  await store.seed({ id: "t-seeded", name: "Seeded", subject: "Seed subject", bodyText: "Seed body", type: "OUTREACH", createdBy: "system" });
  const before = await listTemplates(store);
  const knownId = before[0].id;
  const req = { name: "Edited", subject: "Edited subject", bodyText: "Edited body", type: "OUTREACH", active: true };

  const outcome = { profile: process.env.WORKWELL_INSTANCE ?? "default", knownId, listBefore: before.map((t) => t.subject) };
  try {
    const updated = await updateTemplate(store, events, knownId, req, "admin@test");
    outcome.updateResult = updated ? "updated" : "null";
  } catch (err) {
    outcome.updateResult = err instanceof OutreachTemplateError && err.message === PATIENT_TEMPLATES_READ_ONLY ? "refused-read-only" : "other-error:" + err.message;
  }
  try {
    outcome.unknownUpdate = (await updateTemplate(store, events, "does-not-exist", req, "admin@test")) === null ? "null" : "not-null";
  } catch (err) {
    outcome.unknownUpdate = "threw:" + err.message;
  }
  try {
    await createTemplate(store, events, { name: "New", subject: "New subject", bodyText: "New body", type: null }, "admin@test");
    outcome.createResult = "created";
  } catch (err) {
    outcome.createResult = err instanceof OutreachTemplateError && err.message === PATIENT_TEMPLATES_READ_ONLY ? "refused-read-only" : "other-error:" + err.message;
  }
  outcome.listAfter = (await listTemplates(store)).map((t) => t.subject);
  outcome.storeWrites = store.writes;
  outcome.audits = audits;
  console.log(JSON.stringify(outcome));
`;

test("maui: template create/update are refused as read-only, nothing is written or audited, and the list is unchanged", () => {
  const out = runProfileChild("maui", script);
  assert.equal(out.updateResult, "refused-read-only");
  assert.equal(out.unknownUpdate, "null", "an unknown id is still a 404, not a refusal");
  assert.equal(out.createResult, "refused-read-only");
  assert.equal(out.storeWrites, 0);
  assert.deepEqual(out.audits, [], "no audit row for a change that did not happen");
  assert.deepEqual(out.listAfter, out.listBefore);
});

test("default profile: template create/update persist through the store and are audited", () => {
  const out = runProfileChild(undefined, script);
  assert.equal(out.updateResult, "updated");
  assert.equal(out.unknownUpdate, "null");
  assert.equal(out.createResult, "created");
  assert.equal(out.storeWrites, 2);
  assert.deepEqual(out.audits, ["OUTREACH_TEMPLATE_UPDATED", "OUTREACH_TEMPLATE_CREATED"]);
  assert.deepEqual(out.listAfter, ["Edited subject", "New subject"]);
});
