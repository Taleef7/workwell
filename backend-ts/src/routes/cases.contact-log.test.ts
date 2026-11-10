/**
 * A logged contact and a subject's contact preference (#886), through the routes on the SQLite floor.
 *
 * - POST /api/cases/contact-log: OPEN moves to IN_PROGRESS, nothing about compliance changes, a refusal
 *   writes nothing, and a send afterwards keeps the case IN_PROGRESS.
 * - The work list's "not contacted yet" (`outreach=none`) counts a logged contact; the badge's
 *   `outreachRecordCount` stays a send count.
 * - PUT/DELETE /api/employees/:id/contact-preference, and every send and preview reading it.
 *
 *   node --import tsx --test src/routes/cases.contact-log.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1, createFsBucket } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { SqliteContactPreferenceStore } from "../stores/sqlite/contact-preference-store-sqlite.ts";
import { AuditBackedCampaignStore } from "../stores/audit-campaign-store.ts";
import { handleCases } from "./cases.ts";
import { handleEmployees } from "./employees.ts";
import { authorize } from "../auth/authorize.ts";
import { runCampaign } from "../case/outreach-campaign.ts";
import { resolveSendChannel } from "../case/contact-preference.ts";

const dbPath = join(tmpdir(), `workwell-contact-log-${crypto.randomUUID()}.sqlite`);
const bucketDir = join(tmpdir(), `workwell-contact-log-bucket-${crypto.randomUUID()}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let env: { DB: unknown; BUCKET: unknown };
let store: SqliteCaseStore;
let events: SqliteCaseEventStore;
let prefs: SqliteContactPreferenceStore;
let runId: string;

const post = (path: string, body: unknown, actor = "quality-staff@workwell.dev") =>
  handleCases(
    new Request(`http://x${path}`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    env as never,
    actor,
  ).then((r) => r!);
const get = (path: string) => handleCases(new Request(`http://x${path}`), env as never, "cm@workwell.dev").then((r) => r!);
const log = (body: unknown) => post("/api/cases/contact-log", body);
const pref = (subject: string, method: "PUT" | "DELETE", body?: unknown) =>
  handleEmployees(
    new Request(`http://x/api/employees/${subject}/contact-preference`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
    env as never,
    "quality-staff@workwell.dev",
  ).then((r) => r!);

const typesOf = async (caseId: string) => (await events.caseTimeline(caseId)).map((e) => e.eventType);
let seq = 0;
/** A fresh OPEN case for a subject on its own measure, so tests do not share state. */
async function openCase(subjectId: string, outcomeStatus = "OVERDUE"): Promise<string> {
  const measures = ["audiogram", "hazwoper", "tb_surveillance", "flu_vaccine", "respirator_fit"];
  const measureId = measures[seq % measures.length]!;
  const period = `20${10 + Math.floor(seq / measures.length)}-01-01`;
  seq++;
  return (await store.upsertFromOutcome({ runId, subjectId, measureId, evaluationPeriod: period, outcomeStatus }))!.id;
}

before(async () => {
  db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db, BUCKET: createFsBucket(bucketDir) };
  store = new SqliteCaseStore(db);
  events = new SqliteCaseEventStore(db);
  prefs = new SqliteContactPreferenceStore(db);
  runId = (
    await new SqliteRunStore(db).createRun({
      scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test", requestedScope: { measureId: "audiogram" },
      measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
    })
  ).id;
});

after(() => {
  try {
    rmSync(dbPath, { force: true });
    rmSync(bucketDir, { recursive: true, force: true });
  } catch {
    /* best effort: Windows holds the open SQLite file */
  }
});

// ---- Log a contact ------------------------------------------------------------------------------------

test("contact-log: every malformed field is a 400 naming it, before any case is read", async () => {
  const id = await openCase("emp-006");
  const bad: Array<[unknown, string | undefined]> = [
    ["not json", undefined],
    [{ channel: "PHONE", result: "REACHED" }, "caseIds"],
    [{ caseIds: [], channel: "PHONE", result: "REACHED" }, "caseIds"],
    [{ caseIds: [id, id], channel: "PHONE", result: "REACHED" }, "caseIds"],
    [{ caseIds: Array.from({ length: 21 }, (_, i) => `c${i}`), channel: "PHONE", result: "REACHED" }, "caseIds"],
    [{ caseIds: [id], channel: "FAX", result: "REACHED" }, "channel"],
    [{ caseIds: [id], result: "REACHED" }, "channel"],
    [{ caseIds: [id], channel: "PHONE", result: "MAYBE" }, "result"],
    [{ caseIds: [id], channel: "PHONE", result: "REACHED", note: 5 }, "note"],
    [{ caseIds: [id], channel: "PHONE", result: "REACHED", note: "x".repeat(501) }, "note"],
  ];
  for (const [body, parameter] of bad) {
    const res = await log(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(((await res.json()) as { parameter?: string }).parameter, parameter);
  }
  assert.deepEqual(await typesOf(id), [], "nothing was written");
});

test("contact-log: OPEN moves to IN_PROGRESS, compliance is untouched, and each case gets one event", async () => {
  const a = await openCase("emp-010");
  const b = await openCase("emp-010", "MISSING_DATA");
  const before = await store.getCase(a);
  const res = await log({ caseIds: [a, b], channel: "PHONE", result: "NO_ANSWER", note: "  rang twice  " });
  assert.equal(res.status, 200);
  const out = (await res.json()) as { logged: Array<{ caseId: string; status: string }>; failed: string[] };
  assert.deepEqual(out.logged, [{ caseId: a, status: "IN_PROGRESS" }, { caseId: b, status: "IN_PROGRESS" }]);
  assert.deepEqual(out.failed, []);
  const after = (await store.getCase(a))!;
  assert.equal(after.status, "IN_PROGRESS");
  assert.equal(after.currentOutcomeStatus, before!.currentOutcomeStatus, "the outcome is CQL's, never the contact's");
  assert.equal(after.nextAction, before!.nextAction, "the next action is unchanged");
  for (const id of [a, b]) {
    const logged = (await events.caseTimeline(id)).filter((e) => e.eventType === "CASE_CONTACT_LOGGED");
    assert.equal(logged.length, 1, "one event per case");
    assert.equal(logged[0]!.actor, "quality-staff@workwell.dev");
    const { channel, result, note, fromStatus, toStatus } = logged[0]!.payload;
    assert.deepEqual(
      { channel, result, note, fromStatus, toStatus },
      { channel: "PHONE", result: "NO_ANSWER", note: "rang twice", fromStatus: "OPEN", toStatus: "IN_PROGRESS" },
    );
  }
});

test("contact-log: an IN_PROGRESS case stays IN_PROGRESS", async () => {
  const id = await openCase("emp-011");
  await store.patchCase(id, { status: "IN_PROGRESS" });
  const res = await log({ caseIds: [id], channel: "IN_PERSON", result: "REACHED" });
  assert.equal(res.status, 200);
  assert.equal((await store.getCase(id))!.status, "IN_PROGRESS");
  const payload = (await events.caseTimeline(id)).find((e) => e.eventType === "CASE_CONTACT_LOGGED")!.payload;
  assert.equal(payload.fromStatus, "IN_PROGRESS");
  assert.equal(payload.toStatus, "IN_PROGRESS");
});

test("contact-log: an unknown case is a 404, two subjects a 400, a closed case a 409, and none writes anything", async () => {
  const a = await openCase("emp-012");
  const other = await openCase("emp-013");
  const closed = await openCase("emp-012");
  await store.upsertFromOutcome({ ...(await store.getCase(closed).then((c) => ({
    runId, subjectId: c!.employeeId, measureId: c!.measureId, evaluationPeriod: c!.evaluationPeriod,
  }))), outcomeStatus: "COMPLIANT" });
  assert.notEqual((await store.getCase(closed))!.status, "OPEN");

  const unknown = crypto.randomUUID();
  const r404 = await log({ caseIds: [a, unknown], channel: "PHONE", result: "REACHED" });
  assert.equal(r404.status, 404);
  assert.equal(((await r404.json()) as { id: string }).id, unknown);
  const r400 = await log({ caseIds: [a, other], channel: "PHONE", result: "REACHED" });
  assert.equal(r400.status, 400);
  assert.equal(((await r400.json()) as { error: string }).error, "mixed_subjects");
  const r409 = await log({ caseIds: [a, closed], channel: "PHONE", result: "REACHED" });
  assert.equal(r409.status, 409);
  assert.equal(((await r409.json()) as { error: string; id: string }).error, "case_not_active");
  for (const id of [a, other, closed]) assert.ok(!(await typesOf(id)).includes("CASE_CONTACT_LOGGED"), `${id}: nothing written`);
  assert.equal((await store.getCase(a))!.status, "OPEN");
});

test("contact-log: the staff seat, the lead and admins may log; a viewer and an author may not", () => {
  const p = (role: string) => ({ email: "u@workwell.dev", role });
  for (const role of ["ROLE_QUALITY_STAFF", "ROLE_CASE_MANAGER", "ROLE_ADMIN"]) {
    assert.equal(authorize("POST", "/api/cases/contact-log", p(role) as never).ok, true, role);
  }
  for (const role of ["ROLE_VIEWER", "ROLE_AUTHOR"]) {
    assert.equal(authorize("POST", "/api/cases/contact-log", p(role) as never).ok, false, role);
  }
});

// ---- A send keeps a worked case IN_PROGRESS ------------------------------------------------------------

test("a send after a logged contact keeps the case IN_PROGRESS; a send on an OPEN case leaves it OPEN", async () => {
  const worked = await openCase("emp-014");
  await log({ caseIds: [worked], channel: "PHONE", result: "LEFT_MESSAGE" });
  const sent = await post(`/api/cases/${worked}/actions/outreach?channel=SMS`, null);
  assert.equal(sent.status, 200);
  assert.equal((await store.getCase(worked))!.status, "IN_PROGRESS");
  const audit = (await events.caseTimeline(worked)).find((e) => e.eventType === "CASE_OUTREACH_SENT")!;
  assert.equal(audit.payload.caseStatus, "IN_PROGRESS", "the audit records the status the case was left in");

  const fresh = await openCase("emp-014");
  assert.equal((await post(`/api/cases/${fresh}/actions/outreach?channel=SMS`, null)).status, 200);
  assert.equal((await store.getCase(fresh))!.status, "OPEN");
});

// ---- "Not contacted yet" -------------------------------------------------------------------------------

test("outreach=none drops a case with a logged contact on both loaders; the badge stays a send count", async () => {
  const called = await openCase("emp-015");
  const untouched = await openCase("emp-015");
  await log({ caseIds: [called], channel: "PHONE", result: "NO_ANSWER" });

  // The SQL page path: status=all and no site/search keeps every filter in SQL.
  const ids = async (qs: string) => ((await (await get(`/api/cases?${qs}`)).json()) as Array<{ caseId: string; outreachRecordCount?: number }>);
  const none = await ids("status=all&period=&outreach=none&limit=1000");
  assert.ok(none.some((c) => c.caseId === untouched));
  assert.ok(!none.some((c) => c.caseId === called), "a logged contact is a contact");
  const any = await ids("status=all&period=&outreach=any&limit=1000");
  const calledRow = any.find((c) => c.caseId === called);
  assert.ok(calledRow, "outreach=any includes the logged case");
  assert.equal(calledRow!.outreachRecordCount, 0, "the badge counts sends, and none was sent");

  // The uncapped path: a site filter has no SQL form.
  const site = (await (await import("../config/deployment-profile.ts")).employeeById("emp-015"))!.site;
  const noneUncapped = await ids(`status=all&period=&outreach=none&site=${encodeURIComponent(site)}&limit=1000`);
  assert.ok(noneUncapped.some((c) => c.caseId === untouched));
  assert.ok(!noneUncapped.some((c) => c.caseId === called));

  // The send-only readers stay send-only.
  assert.deepEqual(await events.outreachSentCounts([called]), {});
  assert.equal(await events.hasOutreachSent(called), false, "delivery updates still need a real send");
  assert.deepEqual(await events.contactAttemptCounts([called, untouched]), { [called]: 1 });
});

test("the patient's open gaps show the newest contact, a logged one with its result", async () => {
  const a = await openCase("emp-016");
  await post(`/api/cases/${a}/actions/outreach?channel=EMAIL`, null);
  await new Promise((r) => setTimeout(r, 5));
  await log({ caseIds: [a], channel: "PHONE", result: "REACHED" });
  const res = (await handleEmployees(new Request("http://x/api/employees/emp-016/open-cases"), env as never))!;
  const out = (await res.json()) as {
    openCases: Array<{ caseId: string; lastOutreachChannel: string; lastContactResult: string | null; lastOutreachDeliveryStatus: string | null }>;
    contactPreference: unknown;
  };
  const gap = out.openCases.find((c) => c.caseId === a)!;
  assert.equal(gap.lastOutreachChannel, "PHONE");
  assert.equal(gap.lastContactResult, "REACHED");
  assert.equal(gap.lastOutreachDeliveryStatus, null, "a logged call has no delivery status");
  assert.equal(out.contactPreference, null);

  await new Promise((r) => setTimeout(r, 5));
  await post(`/api/cases/${a}/actions/outreach?channel=SMS`, null);
  const again = ((await (await handleEmployees(new Request("http://x/api/employees/emp-016/open-cases"), env as never))!.json()) as typeof out)
    .openCases.find((c) => c.caseId === a)!;
  assert.equal(again.lastOutreachChannel, "SMS", "a newer send wins");
  assert.equal(again.lastContactResult, null);
});

// ---- Contact preference --------------------------------------------------------------------------------

test("preference: set, read back on the profile, a no-op writes nothing, and clearing deletes it", async () => {
  const set = await pref("emp-017", "PUT", { preferredChannel: "SMS", declinedChannels: ["EMAIL"] });
  assert.equal(set.status, 200);
  const body = (await set.json()) as { contactPreference: { preferredChannel: string; declinedChannels: string[]; updatedBy: string } };
  assert.equal(body.contactPreference.preferredChannel, "SMS");
  assert.deepEqual(body.contactPreference.declinedChannels, ["EMAIL"]);
  assert.equal(body.contactPreference.updatedBy, "quality-staff@workwell.dev");
  const ledger = async () => (await events.recentAuditEventsByType("CONTACT_PREFERENCE_SET", 100)).filter((e) => e.payload.subjectId === "emp-017");
  assert.equal((await ledger()).length, 1);
  assert.deepEqual((await ledger())[0]!.payload.next, { preferredChannel: "SMS", declinedChannels: ["EMAIL"] });

  assert.equal((await pref("emp-017", "PUT", { preferredChannel: "SMS", declinedChannels: ["EMAIL"] })).status, 200);
  assert.equal((await ledger()).length, 1, "the same preference again writes no event");

  const profile = (await (await handleEmployees(new Request("http://x/api/employees/emp-017/profile"), env as never))!.json()) as {
    contactPreference: { preferredChannel: string } | null;
  };
  assert.equal(profile.contactPreference?.preferredChannel, "SMS");

  assert.equal((await pref("emp-017", "PUT", { preferredChannel: null, declinedChannels: [] })).status, 200);
  assert.equal(await prefs.get("emp-017"), null, "an empty preference is no row");
  const cleared = (await events.recentAuditEventsByType("CONTACT_PREFERENCE_CLEARED", 100)).filter((e) => e.payload.subjectId === "emp-017");
  assert.equal(cleared.length, 1);
  assert.equal((await pref("emp-017", "DELETE")).status, 200);
  assert.equal(
    (await events.recentAuditEventsByType("CONTACT_PREFERENCE_CLEARED", 100)).filter((e) => e.payload.subjectId === "emp-017").length,
    1,
    "clearing nothing writes nothing",
  );
});

test("preference: a preferred channel that is also declined, or an unknown channel, is a 400; an unknown subject a 404", async () => {
  assert.equal((await pref("emp-018", "PUT", { preferredChannel: "SMS", declinedChannels: ["SMS"] })).status, 400);
  assert.equal((await pref("emp-018", "PUT", { preferredChannel: "FAX", declinedChannels: [] })).status, 400);
  assert.equal((await pref("emp-018", "PUT", { preferredChannel: null, declinedChannels: ["POST"] })).status, 400);
  assert.equal((await pref("emp-018", "PUT", { preferredChannel: null, declinedChannels: "EMAIL" })).status, 400);
  assert.equal(await prefs.get("emp-018"), null);
  assert.equal((await pref("nobody-here", "PUT", { preferredChannel: "SMS", declinedChannels: [] })).status, 404);
  assert.equal(await prefs.get("nobody-here"), null);
});

test("preference: the staff seat, the lead and admins may set it; a viewer and an author may not", () => {
  const p = (role: string) => ({ email: "u@workwell.dev", role });
  for (const method of ["PUT", "DELETE"]) {
    for (const role of ["ROLE_QUALITY_STAFF", "ROLE_CASE_MANAGER", "ROLE_ADMIN"]) {
      assert.equal(authorize(method, "/api/employees/emp-001/contact-preference", p(role) as never).ok, true, `${method} ${role}`);
    }
    for (const role of ["ROLE_VIEWER", "ROLE_AUTHOR"]) {
      assert.equal(authorize(method, "/api/employees/emp-001/contact-preference", p(role) as never).ok, false, `${method} ${role}`);
    }
  }
});

test("resolveSendChannel: asked-for unless declined; else preferred; else the first not declined; else refused", () => {
  const p = (preferredChannel: "EMAIL" | "SMS" | "PHONE" | null, declinedChannels: Array<"EMAIL" | "SMS" | "PHONE">) =>
    ({ subjectId: "s", preferredChannel, declinedChannels, updatedBy: "x", updatedAt: "" });
  assert.equal(resolveSendChannel(null, undefined), "EMAIL");
  assert.equal(resolveSendChannel(null, "PHONE"), "PHONE");
  assert.equal(resolveSendChannel(p("SMS", []), undefined), "SMS");
  assert.equal(resolveSendChannel(p("SMS", []), "EMAIL"), "EMAIL", "an explicit allowed channel wins over the preference");
  assert.equal(resolveSendChannel(p(null, ["EMAIL"]), undefined), "SMS");
  assert.equal(resolveSendChannel(p(null, ["EMAIL", "SMS"]), undefined), "PHONE");
  assert.throws(() => resolveSendChannel(p(null, ["EMAIL"]), "EMAIL"), { code: "channel_declined" });
  assert.throws(() => resolveSendChannel(p(null, ["EMAIL", "SMS", "PHONE"]), undefined), { code: "all_channels_declined" });
});

test("sends: a declined channel is a 409 with nothing sent or recorded; no channel follows the preference", async () => {
  const id = await openCase("emp-019");
  await pref("emp-019", "PUT", { preferredChannel: "PHONE", declinedChannels: ["EMAIL"] });

  const refused = await post(`/api/cases/${id}/actions/outreach?channel=EMAIL`, null);
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { error: string }).error, "channel_declined");
  assert.ok(!(await typesOf(id)).includes("CASE_OUTREACH_SENT"), "nothing recorded");

  const preview = await get(`/api/cases/${id}/actions/outreach/preview?channel=EMAIL`);
  assert.equal(preview.status, 409, "the preview gives the send's answer");
  const previewDefault = (await (await get(`/api/cases/${id}/actions/outreach/preview`)).json()) as { channel: string };
  assert.equal(previewDefault.channel, "PHONE");

  assert.equal((await post(`/api/cases/${id}/actions/outreach`, null)).status, 200);
  const sent = (await events.caseTimeline(id)).find((e) => e.eventType === "CASE_OUTREACH_SENT")!;
  assert.equal((sent.payload.action as { channel: string }).channel, "PHONE", "no channel given: the preferred one");
});

test("sends: a subject who declined every channel is a 409 on the single send and on the patient's message", async () => {
  const a = await openCase("emp-020");
  const b = await openCase("emp-020");
  await pref("emp-020", "PUT", { preferredChannel: null, declinedChannels: ["EMAIL", "SMS", "PHONE"] });
  const single = await post(`/api/cases/${a}/actions/outreach`, null);
  assert.equal(single.status, 409);
  assert.equal(((await single.json()) as { error: string }).error, "all_channels_declined");

  // The employee profile's patient message sends one per case in a loop that reports per-case failures:
  // the refusal is the route's, before the loop, never a `failed[]` entry.
  const many = await post("/api/cases/patient-outreach", { caseIds: [a, b] });
  assert.equal(many.status, 409);
  assert.equal(((await many.json()) as { error: string }).error, "all_channels_declined");
  const dry = await post("/api/cases/patient-outreach", { caseIds: [a, b], dryRun: true });
  assert.equal(dry.status, 409, "the dry run gives the send's answer");
  const declined = await post("/api/cases/patient-outreach", { caseIds: [a, b], channel: "SMS" });
  assert.equal(declined.status, 409);
  for (const id of [a, b]) assert.ok(!(await typesOf(id)).includes("CASE_OUTREACH_SENT"));
});

test("campaigns skip a subject who declined the campaign's channel, and say how many, the dry run too", async () => {
  // Isolated: a campaign targets every OPEN case, so its own database.
  const cdb = await createSqliteD1(":memory:");
  await cdb.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const cases = new SqliteCaseStore(cdb);
  const ev = new SqliteCaseEventStore(cdb);
  const cp = new SqliteContactPreferenceStore(cdb);
  const { practiceToday } = await import("../config/practice-date.ts");
  const { bucketPeriodForMeasure } = await import("../run/compliance-period.ts");
  const period = bucketPeriodForMeasure("audiogram", practiceToday());
  const run = await new SqliteRunStore(cdb).createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test", requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  });
  const keep = (await cases.upsertFromOutcome({ runId: run.id, subjectId: "emp-001", measureId: "audiogram", evaluationPeriod: period, outcomeStatus: "OVERDUE" }))!.id;
  const skip = (await cases.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: period, outcomeStatus: "OVERDUE" }))!.id;
  await cp.upsert({ subjectId: "emp-006", preferredChannel: "SMS", declinedChannels: ["EMAIL"], updatedBy: "x", updatedAt: new Date().toISOString() });
  const deps = { cases, events: ev, outcomes: new (await import("../stores/sqlite/outcome-store-sqlite.ts")).SqliteOutcomeStore(cdb), campaigns: new AuditBackedCampaignStore(ev), contactPreferences: cp };

  const dry = await runCampaign(deps, { channel: "EMAIL", measureId: "audiogram", dryRun: true }, "cm@workwell.dev");
  assert.equal(dry.skippedDeclined, 1);
  assert.deepEqual(dry.recipients.map((r) => r.caseId), [keep]);
  const live = await runCampaign(deps, { channel: "EMAIL", measureId: "audiogram" }, "cm@workwell.dev");
  assert.equal(live.skippedDeclined, 1);
  assert.deepEqual(live.recipients.map((r) => r.caseId), [keep]);
  assert.ok(!(await ev.caseTimeline(skip)).some((e) => e.eventType === "CASE_OUTREACH_SENT"), "the declined subject got nothing");
  const sms = await runCampaign(deps, { channel: "SMS", measureId: "audiogram", dryRun: true }, "cm@workwell.dev");
  assert.equal(sms.skippedDeclined, 0, "a channel they did not decline reaches them");
});
