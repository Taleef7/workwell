/**
 * The sandbox data boundary on the PILOT profile (MM-2 PR 3, ADR-082).
 *
 * The mirror of `subject-lists.test.ts`'s gate test: there the corpus id is the outsider, here the
 * occupational id is. A gate tested on one profile only would read as working while refusing every
 * legitimate identifier on the other — which is what a single hardcoded namespace pattern did before
 * this pair existed.
 *
 * The three cases that matter are the three different answers a conforming-looking identifier gets:
 * a real corpus patient MATCHES, a conforming id nobody has is NOT_FOUND (so the review queue is
 * exercised with synthetic-shaped ids rather than being unreachable), and an identifier from another
 * deployment's namespace is REFUSED before anything is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const testScript = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { handleSubjectLists } from "./src/routes/subject-lists.ts";

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const env = { DB: db };
  const post = async (body) => {
    const res = await handleSubjectLists(
      new Request("http://x/api/subject-lists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      "quality-lead@workwell.dev",
    );
    return { status: res.status, body: await res.json() };
  };

  // A fixture patient (three digits), a generated one (five), and one nobody has.
  const accepted = await post({ name: "ACO attribution", identifiers: ["pat-001", "pat-00060", "pat-99999"] });
  // An identifier from the OTHER deployment's namespace.
  const refused = await post({ name: "wrong namespace", identifiers: ["pat-001", "emp-001"] });
  const listed = await handleSubjectLists(new Request("http://x/api/subject-lists"), env, "quality-lead@workwell.dev");

  console.log(JSON.stringify({ accepted, refused, lists: await listed.json() }));
`;

test("Maui profile — the corpus namespace is admitted in BOTH spellings, and a missing id is NOT_FOUND", () => {
  const out = runProfileChild("maui", testScript, { WORKWELL_MAUI_CORPUS_SIZE: "100" });
  const accepted = out.accepted as { status: number; body: { counts: Record<string, number> } };
  assert.equal(accepted.status, 201);
  // pat-001 is a hand-written fixture patient and pat-00060 a generated one (the child composes a
  // 100-patient corpus so both exist): a gate written for the generated five-digit form alone would
  // refuse the first 48 real patients in the sandbox.
  assert.equal(accepted.body.counts.matched, 2);
  // Conforming but absent — the review queue is reachable with synthetic-shaped identifiers, which is
  // what makes this a NAMESPACE gate rather than an existence gate.
  assert.equal(accepted.body.counts.notFound, 1);
});

test("Maui profile — an occupational identifier is REFUSED before persistence, and nothing is written", () => {
  const out = runProfileChild("maui", testScript, { WORKWELL_MAUI_CORPUS_SIZE: "100" });
  const refused = out.refused as { status: number; body: { error: string; outsideNamespace: number } };
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "identifier_outside_sandbox_namespace");
  assert.equal(refused.body.outsideNamespace, 1);
  // Exactly one list exists: the accepted one. The refusal wrote nothing, not even a header row.
  const lists = out.lists as { name: string }[];
  assert.deepEqual(lists.map((l) => l.name), ["ACO attribution"]);
});
