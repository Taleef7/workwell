import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bootSidecars, fetchSidecars, type FetchDeps, type SidecarTarget } from "./terminology-fetch.ts";
import type { OfficialManifest } from "./official-artifacts.ts";

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const GOOD = '{"valueSets":[]}';
const target = (path: string, text = GOOD, required = true): SidecarTarget => ({ kind: "official", catalogId: "cms1", sha256: sha(text), path, required });

function harness(files: Record<string, string>, objects: Record<string, string>, opts: { open?: () => never } = {}) {
  const written: Record<string, string> = {};
  const asked: string[] = [];
  const deps: FetchDeps = {
    bucket: async () => {
      if (opts.open) opts.open();
      return {
        get: async (key: string) => {
          asked.push(key);
          const text = objects[key];
          return text === undefined ? null : ({ arrayBuffer: async () => new TextEncoder().encode(text).buffer } as never);
        },
      } as never;
    },
    exists: (path) => path in files,
    read: (path) => files[path]!,
    write: (path, text) => { written[path] = text; },
    redact: (text) => text.split("acct123.r2").join("<endpoint>"),
  };
  return { deps, written, asked };
}

const keyOf = (text: string) => `terminology/${sha(text).slice("sha256:".length)}.json`;

test("a missing sidecar is fetched by its pin and written where the loader reads it", async () => {
  const { deps, written, asked } = harness({}, { [keyOf(GOOD)]: GOOD });
  const report = await fetchSidecars([target("/m/official/cms1/terminology.json")], deps);
  assert.deepEqual(report.fetched, ["official/cms1"]);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(asked, [keyOf(GOOD)]);
  assert.equal(written["/m/official/cms1/terminology.json"], GOOD);
});

test("a present sidecar that matches its pin is left alone, and the bucket is never opened", async () => {
  const { deps, written } = harness({ "/p": GOOD }, {}, { open: () => { throw new Error("opened"); } });
  const report = await fetchSidecars([target("/p")], deps);
  assert.deepEqual(report.present, ["official/cms1"]);
  assert.deepEqual(written, {});
});

test("bytes that do not hash to the pin are refused, never written", async () => {
  const { deps, written } = harness({}, { [keyOf(GOOD)]: '{"valueSets":["tampered"]}' });
  const report = await fetchSidecars([target("/p")], deps);
  assert.deepEqual(written, {});
  assert.match(report.problems.join(), /does not hash to the committed pin/);
});

test("a stale local file is replaced, an absent object and an unopenable bucket are reported", async () => {
  const stale = harness({ "/p": "old" }, { [keyOf(GOOD)]: GOOD });
  assert.deepEqual((await fetchSidecars([target("/p")], stale.deps)).fetched, ["official/cms1"]);

  const absent = harness({}, {});
  assert.match((await fetchSidecars([target("/p")], absent.deps)).problems.join(), /is not in the bucket/);

  const down = harness({}, {}, { open: () => { throw new Error("connect ECONNREFUSED https://acct123.r2.example"); } });
  const problems = (await fetchSidecars([target("/p")], down.deps)).problems.join();
  assert.match(problems, /could not be opened/);
  assert.doesNotMatch(problems, /acct123/, "the account id never reaches the log");
});

test("a miss on a sidecar no routed measure needs is a note, never an alert", async () => {
  const { deps } = harness({}, {});
  const report = await fetchSidecars([target("/p", GOOD, false)], deps);
  assert.deepEqual(report.problems, []);
  assert.match(report.notes.join(), /is not in the bucket/);
});

test("a boot fetches every vendored CMS artifact's sidecar (required when routed) and each routed translation's", () => {
  const manifest = (hex: string) => ({ terminology: { file: "terminology.json", sha256: `sha256:${hex.repeat(64)}` } }) as unknown as OfficialManifest;
  const manifests = {
    official: (id: string) => (["cms1", "cms2", "cms3"].includes(id) ? manifest("a") : null),
    derived: (id: string) => (id === "cms1" || id === "cms3" ? manifest("b") : null),
  };
  const root = pathToFileURL(join(tmpdir(), "m") + "/");
  const vendored = () => ["cms3", "cms2", "cms1"];
  const env = { WORKWELL_OFFICIAL_MEASURES: "cms2,cms1", WORKWELL_DERIVED_MEASURES: "cms1" };
  const targets = bootSidecars(env, manifests, root, vendored);
  assert.deepEqual(
    targets.map((t) => `${t.kind}/${t.catalogId}:${t.required ? "required" : "optional"}`),
    ["official/cms1:required", "derived/cms1:required", "official/cms2:required", "official/cms3:optional"],
    "cms3's translation is not routed, so it is not fetched",
  );
  assert.match(targets[1]!.path.replace(/\\/g, "/"), /\/m\/derived\/cms1\/terminology\.json$/);
  assert.deepEqual(
    bootSidecars({}, manifests, root, vendored).map((t) => t.required),
    [false, false, false],
    "nothing routed: every vendored sidecar is optional",
  );
});
