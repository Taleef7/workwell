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

test("a slow object times out without holding the others back, and each miss is counted by kind", async () => {
  const fast = '{"fast":true}';
  const objects: Record<string, string> = { [keyOf(fast)]: fast, [keyOf('{"bad":1}')]: '{"tampered":1}' };
  const written: Record<string, string> = {};
  const deps: FetchDeps = {
    bucket: async () => ({
      get: async (key: string) => {
        if (key === keyOf('{"slow":1}')) return new Promise(() => {}) as never; // never answers
        const text = objects[key];
        return text === undefined ? null : ({ arrayBuffer: async () => new TextEncoder().encode(text).buffer } as never);
      },
    }) as never,
    exists: () => false,
    read: () => "",
    write: (path, text) => { written[path] = text; },
  };
  const targets = [target("/slow", '{"slow":1}'), target("/fast", fast), target("/absent", '{"absent":1}'), target("/bad", '{"bad":1}')];
  const report = await fetchSidecars(targets, deps, { perObjectTimeoutMs: 20, concurrency: 2, attempts: 1 });
  assert.deepEqual(Object.keys(written), ["/fast"], "the fast one arrived although a slow one never did");
  assert.deepEqual(report.failures, { bucketUnavailable: 0, notInBucket: 1, hashMismatch: 1, timedOut: 1, readFailed: 0, writeFailed: 0 });
  assert.equal(report.problems.length, 3);
});

test("the published health is counts only, and the boot step records it before and after, then re-checks routing", async () => {
  const { fetchRoutedTerminologyAtBoot, terminologyHealthOf } = await import("./terminology-fetch.ts");
  const health = terminologyHealthOf([target("/a"), { ...target("/b", GOOD, false), catalogId: "cms2" }], {
    present: [], fetched: ["official/cms1"], problems: [], notes: ["x"], durationMs: 12, retries: 2,
    failures: { bucketUnavailable: 0, notInBucket: 1, hashMismatch: 0, timedOut: 0, readFailed: 0, writeFailed: 0 },
    errorCodes: { ECONNRESET: 2 },
  }, true);
  assert.deepEqual(health, {
    finished: true, durationMs: 12, required: 1, fetched: 1, alreadyPresent: 0, missingRequired: 0, missingOptional: 1,
    failures: { bucketUnavailable: 0, notInBucket: 1, hashMismatch: 0, timedOut: 0, readFailed: 0, writeFailed: 0 },
    errorCodes: { ECONNRESET: 2 }, retries: 2,
  });
  assert.doesNotMatch(JSON.stringify(health), /terminology\/|official\/cms|sha256/, "no key, label or pin is published");

  const recorded: boolean[] = [];
  let rechecked = 0;
  const { deps } = harness({}, {});
  await fetchRoutedTerminologyAtBoot(
    { WORKWELL_OFFICIAL_MEASURES: "cms122" },
    { record: (h) => recorded.push(h.finished), refreshRouting: () => { rechecked += 1; return 0; } },
    deps,
  );
  assert.deepEqual(recorded, [false, true], "recorded as running, then as finished");
  assert.equal(rechecked, 1, "the routing check is re-run once the fetch is done");
});

test("a read that fails is retried with backoff, and every failed attempt's code is counted, never its message", async () => {
  let calls = 0;
  const slept: number[] = [];
  const written: Record<string, string> = {};
  const deps: FetchDeps = {
    bucket: async () => ({
      get: async () => {
        calls += 1;
        if (calls <= 2) throw Object.assign(new Error("socket hang up at https://acct123.r2.example"), { code: "ECONNRESET" });
        return { arrayBuffer: async () => new TextEncoder().encode(GOOD).buffer } as never;
      },
    }) as never,
    exists: () => false,
    read: () => "",
    write: (path, text) => { written[path] = text; },
  };
  const report = await fetchSidecars([target("/p")], deps, { sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(report.fetched, ["official/cms1"], "the third attempt succeeded");
  assert.equal(report.retries, 2);
  assert.deepEqual(slept, [1000, 2000], "backs off between attempts");
  assert.deepEqual(report.errorCodes, { ECONNRESET: 2 });
  assert.doesNotMatch(JSON.stringify(report.errorCodes), /acct123|socket/, "a code, never the message");
});

test("a sidecar read but not writable is a write failure, not a read failure", async () => {
  const { deps } = harness({}, { [keyOf(GOOD)]: GOOD });
  deps.write = () => { throw Object.assign(new Error("read-only file system"), { code: "EROFS" }); };
  const report = await fetchSidecars([target("/p")], deps, { sleep: async () => {} });
  assert.deepEqual({ write: report.failures.writeFailed, read: report.failures.readFailed }, { write: 1, read: 0 });
  assert.deepEqual(report.errorCodes, { EROFS: 1 });
});

test("after the last attempt, a read failure is reported once with its code", async () => {
  const deps: FetchDeps = {
    bucket: async () => ({ get: async () => { throw Object.assign(new Error("nope"), { $metadata: { httpStatusCode: 503 } }); } }) as never,
    exists: () => false, read: () => "", write: () => {},
  };
  const report = await fetchSidecars([target("/p")], deps, { sleep: async () => {} });
  assert.equal(report.failures.readFailed, 1);
  assert.deepEqual(report.errorCodes, { http503: 4 }, "four attempts, each counted");
  assert.match(report.problems.join(), /after 4 attempts/);
});
