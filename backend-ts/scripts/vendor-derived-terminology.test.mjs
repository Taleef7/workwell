/**
 * The translation sidecar producer (`vendor-derived-terminology.mjs`).
 *
 * Every test here is about a failure direction on the deploy path: the worker boots even when the router
 * refuses a translation, so the only place a wrong sidecar can be stopped before it ships is this
 * script's exit code. Driven in-process through `main(argv, deps)` with an injected VSAC transport — the
 * paging loop in `vsac-expansion.mjs` still runs for real — and once as a plain `node` child process,
 * because that is how the deploy invokes it.
 *
 * All terminology is synthetic: OIDs under `9.9.*`, codes under `example.test`. No VSAC content.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { main } from "./vendor-derived-terminology.mjs";
import { DEFAULT_VSAC_MANIFEST, declaredValueSets } from "./vsac-expansion.mjs";

// `fileURLToPath`, not `URL.pathname`: the repo path has spaces, which a pathname percent-encodes.
const SCRIPT = fileURLToPath(new URL("./vendor-derived-terminology.mjs", import.meta.url));
const CANON = "http://cts.nlm.nih.gov/fhir/ValueSet/";
const RELEASE_EMIT = "http://example.test/Library/release-emit";
const RELEASE_COMMITTED = "http://example.test/Library/release-committed";
const KEYED = { WORKWELL_VSAC_API_KEY: "test-key" };
const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** `n` synthetic codes across two systems, so canonical ordering has something to sort. */
const codes = (prefix, n) =>
  Array.from({ length: n }, (_, i) => ({
    system: i % 2 === 0 ? "http://example.test/cs-b" : "http://example.test/cs-a",
    code: `${prefix}-${i}`,
  }));

/** What VSAC holds at "the release" for each synthetic OID. "9.9.10" sorts between "9.9.1" and "9.9.2". */
const vsacTable = () => ({
  "9.9.1": { codes: codes("one", 3) },
  "9.9.2": { codes: codes("two", 5) },
  "9.9.10": { codes: codes("ten", 4) },
});

const elmLibrary = (name, defs) => ({
  resource: {
    resourceType: "Library",
    name,
    content: [
      {
        contentType: "application/elm+json",
        data: Buffer.from(JSON.stringify({ library: { valueSets: { def: defs } } }), "utf8").toString("base64"),
      },
    ],
  },
});

/**
 * A translation bundle whose declarations are split across TWO libraries, overlap, and include a
 * versioned canonical — so a walk over one library, or a key that kept `|version`, asks for the wrong set.
 */
function bundle({ reversed = false } = {}) {
  const a = [{ id: `${CANON}9.9.2`, name: "Two" }, { id: `${CANON}9.9.1`, name: "One" }];
  const b = [{ id: `${CANON}9.9.10`, name: "Ten" }, { id: `${CANON}9.9.1|2027`, name: "One again" }];
  const libraries = [elmLibrary("Main", reversed ? [...a].reverse() : a), elmLibrary("Common", reversed ? [...b].reverse() : b)];
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [{ resource: { resourceType: "Measure", name: "SyntheticTranslationFHIR" } }, ...(reversed ? libraries.reverse() : libraries)],
  };
}

/** CMS's draft sidecar for the same measure: 9.9.1 and 9.9.2 present (keyed by url), 9.9.10 absent. */
const baseSidecar = (catalogId = "cms999") => ({
  catalogId,
  source: { repo: "upstream", ref: "abc", measure: "SyntheticDraftFHIR" },
  valueSets: [
    { url: `${CANON}9.9.1`, oid: "9.9.1", declaredTotal: 2, codes: codes("old-one", 2) },
    { url: `${CANON}9.9.2`, oid: "9.9.2", declaredTotal: 4, codes: codes("old-two", 4) },
    // Not declared by the translation: must not appear in the block at all.
    { url: `${CANON}9.9.77`, oid: "9.9.77", declaredTotal: 1, codes: codes("old-77", 1) },
  ],
});

/**
 * A VSAC stand-in that pages by `offset` the way the real one does. `order` reorders a set's codes and
 * `pageSize` splits them, so two runs can see the same set served differently. Per-OID overrides:
 * `total` (undefined = omitted), `echo` (null = no url; default = the right canonical).
 */
function vsacStub(table, { pageSize = 1000, order = (list) => list } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, init });
    const oid = decodeURIComponent(parsed.pathname.split("/ValueSet/")[1].split("/")[0]);
    const entry = table[oid];
    if (!entry) return { ok: false, status: 404, text: async () => "" };
    const offset = Number(parsed.searchParams.get("offset"));
    const page = order(entry.codes).slice(offset, offset + pageSize);
    const total = "total" in entry ? entry.total : entry.codes.length;
    const echo = entry.echo === undefined ? `${CANON}${oid}` : entry.echo;
    const body = {
      resourceType: "ValueSet",
      ...(echo === null ? {} : { url: echo }),
      expansion: { ...(total === undefined ? {} : { total }), contains: page },
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/**
 * Hermetic even if the transport seam breaks. Every run injects its own `fetch`, so nothing should reach
 * the global one; if the seam were dropped, the real global would dial the live VSAC host. Mutation-
 * checking the seam did exactly that (401s for the fake key). Recorded and answered 404, which
 * `vsac-expansion.mjs` does not retry, and asserted empty after every run.
 */
const leaked = [];
let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    leaked.push(String(url));
    return { ok: false, status: 404, text: async () => "" };
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

/** A translation directory with bundle.json and, optionally, manifest.json and a base sidecar beside it. */
async function translationDir({ manifest, base, bundleOptions, bundleOverride } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "workwell-derived-terminology-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "bundle.json"), JSON.stringify(bundleOverride ?? bundle(bundleOptions)));
  if (manifest !== undefined) await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (base !== undefined) await writeFile(join(dir, "base-terminology.json"), JSON.stringify(base));
  return dir;
}

/**
 * Drive `main` in-process. With no `fetch`, any request is a test failure: it is recorded and answered
 * 404 (which `vsac-expansion.mjs` does not retry) rather than thrown, because a throw inside the
 * transport is retried with backoff and would surface only as a slow, ambiguous exit 1.
 */
async function run(argv, { env = KEYED, fetch } = {}) {
  let stdout = "";
  let stderr = "";
  const forbidden = [];
  const code = await main(argv, {
    env,
    fetch:
      fetch ??
      (async (url) => {
        forbidden.push(String(url));
        return { ok: false, status: 404, text: async () => "" };
      }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  assert.deepEqual(forbidden, [], "this run must not dial VSAC");
  assert.deepEqual(leaked.splice(0), [], "a request bypassed the injected transport and reached the global fetch");
  return { code, stdout, stderr };
}

const emitArgs = (dir, release = RELEASE_EMIT) => [
  "--catalog-id", "cms999", "--output-dir", dir, "--emit-block",
  "--base-terminology", join(dir, "base-terminology.json"), "--vsac-manifest", release,
];
const verifyArgs = (dir, ...extra) => ["--catalog-id", "cms999", "--output-dir", dir, ...extra];

/** Emit a block into `dir`, then commit it as the translation's manifest — the operator's two steps. */
async function committedTranslation(table = vsacTable()) {
  const dir = await translationDir({ base: baseSidecar() });
  const emitted = await run(emitArgs(dir, RELEASE_COMMITTED), { fetch: vsacStub(table).fetch });
  assert.equal(emitted.code, 0, emitted.stderr);
  const terminology = JSON.parse(emitted.stdout);
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ catalogId: "cms999", terminology }, null, 2));
  return { dir, terminology, sidecar: await readFile(join(dir, "terminology.json"), "utf8") };
}

describe("refusals before any request", () => {
  it("exits 1 with a sentence when WORKWELL_VSAC_API_KEY is unset — never a silent skip", async () => {
    const dir = await translationDir({ manifest: { terminology: { completion: { manifest: RELEASE_COMMITTED } } } });

    const result = await run(verifyArgs(dir, "--verify-pin"), { env: {} });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /WORKWELL_VSAC_API_KEY is unset/);
    assert.match(result.stderr, /nothing was written/);
    assert.equal(existsSync(join(dir, "terminology.json")), false);
  });

  it("verify mode REFUSES --vsac-manifest, so nothing can drift from the committed manifest", async () => {
    const dir = await translationDir({ manifest: { terminology: { completion: { manifest: RELEASE_COMMITTED } } } });

    const result = await run(verifyArgs(dir, "--verify-pin", "--vsac-manifest", RELEASE_COMMITTED));

    assert.equal(result.code, 2, "a usage error, even when the flag agrees with the manifest today");
    assert.match(result.stderr, /--vsac-manifest is refused without --emit-block/);
  });

  it("verify mode refuses --base-terminology rather than ignoring it", async () => {
    const dir = await translationDir({ manifest: { terminology: { completion: { manifest: RELEASE_COMMITTED } } } });

    const result = await run(verifyArgs(dir, "--base-terminology", join(dir, "x.json")));

    assert.equal(result.code, 2);
    assert.match(result.stderr, /--base-terminology is read only with --emit-block/);
  });

  it("a flag missing its value does not swallow the next flag", async () => {
    const dir = await translationDir({ base: baseSidecar() });

    const result = await run(["--catalog-id", "cms999", "--output-dir", dir, "--emit-block",
      "--base-terminology", join(dir, "base-terminology.json"), "--vsac-manifest", "--verify-pin"]);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /--vsac-manifest needs a value/);
  });

  it("verify mode exits 1 when the manifest names no VSAC release", async () => {
    const dir = await translationDir({ manifest: { terminology: { sha256: "sha256:00" } } });

    const result = await run(verifyArgs(dir, "--verify-pin"));

    assert.equal(result.code, 1);
    assert.match(result.stderr, /the translation's manifest names no VSAC release/);
  });

  it("verify mode exits 1 when there is no manifest.json at all", async () => {
    const dir = await translationDir();

    const result = await run(verifyArgs(dir, "--verify-pin"));

    assert.equal(result.code, 1);
    assert.match(result.stderr, /manifest\.json not found/);
  });

  it("emit mode requires both --vsac-manifest and --base-terminology", async () => {
    const dir = await translationDir({ base: baseSidecar() });

    const noRelease = await run(["--catalog-id", "cms999", "--output-dir", dir, "--emit-block",
      "--base-terminology", join(dir, "base-terminology.json")]);
    const noBase = await run(["--catalog-id", "cms999", "--output-dir", dir, "--emit-block",
      "--vsac-manifest", RELEASE_EMIT]);

    assert.equal(noRelease.code, 2, `no --vsac-manifest must be a usage error; stderr: ${noRelease.stderr}`);
    assert.equal(noBase.code, 2, `no --base-terminology must be a usage error; stderr: ${noBase.stderr}`);
    assert.match(noRelease.stderr, /--emit-block requires --vsac-manifest/);
  });

  it("emit mode refuses --verify-pin — one produces the pin, the other checks it", async () => {
    const dir = await translationDir({ base: baseSidecar() });

    const result = await run([...emitArgs(dir), "--verify-pin"]);

    assert.equal(result.code, 2);
  });

  it("refuses a bundle whose ELM declares no value sets — an empty sidecar would pass every check vacuously", async () => {
    const empty = { entry: [{ resource: { resourceType: "Measure", name: "SyntheticTranslationFHIR" } }, elmLibrary("Main", [])] };
    const dir = await translationDir({ base: baseSidecar(), bundleOverride: empty });

    const result = await run(emitArgs(dir));

    assert.equal(result.code, 1, `an empty declaration list must be refused, got exit ${result.code}; stdout: ${result.stdout}`);
    assert.match(result.stderr, /declares no value sets/);
    assert.equal(existsSync(join(dir, "terminology.json")), false);
  });

  it("refuses a bundle with no named Measure — source.measure would silently drop out of the sidecar", async () => {
    const unnamed = { entry: bundle().entry.filter((e) => e.resource.resourceType !== "Measure") };
    const dir = await translationDir({ base: baseSidecar(), bundleOverride: unnamed });

    const result = await run(emitArgs(dir));

    assert.equal(result.code, 1);
    assert.match(result.stderr, /carries no named Measure resource/);
  });

  it("emit mode refuses a base sidecar for another measure — every `had` would be wrong", async () => {
    const dir = await translationDir({ base: baseSidecar("cms998") });

    const result = await run(emitArgs(dir));

    assert.equal(result.code, 1);
    assert.match(result.stderr, /is the sidecar for "cms998", not "cms999"/);
  });
});

describe("expansion: no partial sidecar, no fallback", () => {
  const refused = async (table, pattern) => {
    const dir = await translationDir({ base: baseSidecar() });

    const result = await run(emitArgs(dir), { fetch: vsacStub(table).fetch });

    assert.equal(result.code, 1, `the run must refuse (exit 1), got exit ${result.code}; stderr: ${result.stderr}`);
    assert.match(result.stderr, pattern);
    assert.match(result.stderr, /Nothing was written/);
    assert.equal(existsSync(join(dir, "terminology.json")), false, "no partial sidecar");
    assert.equal(result.stdout, "", "no block for a refused run");
  };

  it("refuses a SHORT expansion", async () => {
    const table = vsacTable();
    table["9.9.2"].total = 7; // claims 7, serves 5
    await refused(table, /could not expand 9\.9\.2 .*claimed 7 codes .* returned 5 distinct/);
  });

  it("refuses an expansion carrying no expansion.total", async () => {
    const table = vsacTable();
    table["9.9.1"].total = undefined;
    await refused(table, /could not expand 9\.9\.1 .*no expansion\.total/);
  });

  it("refuses an answer whose echoed url names ANOTHER value set", async () => {
    const table = vsacTable();
    table["9.9.10"].echo = `${CANON}9.9.555`;
    await refused(table, /could not expand 9\.9\.10 .*with an expansion of .*9\.9\.555/);
  });

  it("fails the WHOLE run when any single set fails — the other sets do not save it", async () => {
    // 9.9.1 and 9.9.10 would succeed (and are requested first, in code-point order); 9.9.2 404s.
    const table = vsacTable();
    delete table["9.9.2"];
    await refused(table, /could not expand 9\.9\.2 .*HTTP 404/);
  });
});

describe("the sidecar and the emitted block", () => {
  it("emits exactly one JSON document whose had/now/reason/declaredTotal and sha256 match the written file", async () => {
    const dir = await translationDir({ base: baseSidecar() });

    const result = await run(emitArgs(dir), { fetch: vsacStub(vsacTable()).fetch });

    assert.equal(result.code, 0, result.stderr);
    // The whole of stdout parses: one document, nothing else, so it can be redirected into a file.
    const block = JSON.parse(result.stdout);
    const written = await readFile(join(dir, "terminology.json"), "utf8");
    assert.deepEqual(block, {
      file: "terminology.json",
      valueSets: 3,
      codes: 12,
      truncated: [],
      completion: {
        source: "vsac",
        manifest: RELEASE_EMIT,
        // Code-point OID order; `had` from CMS's draft sidecar, 0 where it shipped none.
        valueSets: [
          { oid: "9.9.1", reason: "release", had: 2, now: 3, declaredTotal: 3 },
          { oid: "9.9.10", reason: "release", had: 0, now: 4, declaredTotal: 4 },
          { oid: "9.9.2", reason: "release", had: 4, now: 5, declaredTotal: 5 },
        ],
      },
      sha256: sha256(written),
    });
    assert.match(result.stderr, /3 value sets, 12 codes/, "human-readable output goes to stderr in this mode");
  });

  it("writes the official sidecar shape: VSAC canonical urls, VSAC totals, canonical code order", async () => {
    const dir = await translationDir({ base: baseSidecar() });

    await run(emitArgs(dir), { fetch: vsacStub(vsacTable()).fetch });

    const written = await readFile(join(dir, "terminology.json"), "utf8");
    assert.ok(written.endsWith("}\n") && !written.slice(0, -1).includes("\n"), "JSON.stringify(x, null, 0) + newline");
    const sidecar = JSON.parse(written);
    assert.deepEqual(Object.keys(sidecar), ["catalogId", "source", "valueSets"]);
    assert.deepEqual(sidecar.source, { repo: "cts.nlm.nih.gov/fhir", ref: RELEASE_EMIT, measure: "SyntheticTranslationFHIR" });
    assert.deepEqual(sidecar.valueSets.map((v) => v.url), [`${CANON}9.9.1`, `${CANON}9.9.10`, `${CANON}9.9.2`]);
    for (const valueSet of sidecar.valueSets) {
      assert.deepEqual(Object.keys(valueSet), ["url", "oid", "declaredTotal", "codes"]);
      assert.equal(valueSet.declaredTotal, valueSet.codes.length);
      const keys = valueSet.codes.map((c) => `${c.system}|${c.code}`);
      assert.deepEqual(keys, [...keys].sort(), `${valueSet.oid}: codes in system|code order`);
    }
  });

  it("is byte-identical however VSAC pages and orders the codes, and however the ELM orders its declarations", async () => {
    const first = await translationDir({ base: baseSidecar() });
    const second = await translationDir({ base: baseSidecar(), bundleOptions: { reversed: true } });

    const a = await run(emitArgs(first), { fetch: vsacStub(vsacTable(), { pageSize: 2, order: (l) => [...l].reverse() }).fetch });
    const b = await run(emitArgs(second), {
      fetch: vsacStub(vsacTable(), { pageSize: 3, order: (l) => [...l.slice(1), l[0]] }).fetch,
    });

    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    const bytesA = await readFile(join(first, "terminology.json"));
    const bytesB = await readFile(join(second, "terminology.json"));
    assert.ok(bytesA.equals(bytesB), "the sidecar is pinned by hash, so its bytes are the artifact");
    assert.equal(JSON.parse(a.stdout).sha256, JSON.parse(b.stdout).sha256);
  });

  it("asks VSAC for each declared OID once, with the --vsac-manifest release — never the 2025 default", async () => {
    const dir = await translationDir({ base: baseSidecar() });
    const stub = vsacStub(vsacTable());

    await run(emitArgs(dir), { fetch: stub.fetch });

    const requested = stub.calls.map((c) => decodeURIComponent(c.url.pathname.split("/ValueSet/")[1].split("/")[0]));
    assert.deepEqual(requested, ["9.9.1", "9.9.10", "9.9.2"], "the versioned canonical collapsed onto 9.9.1");
    for (const call of stub.calls) {
      assert.equal(call.url.searchParams.get("manifest"), RELEASE_EMIT);
      assert.notEqual(call.url.searchParams.get("manifest"), DEFAULT_VSAC_MANIFEST);
    }
  });
});

describe("verify mode and --verify-pin (the deploy step)", () => {
  it("expands at the release manifest.json records — never the flag's, never the 2025 default", async () => {
    const dir = await translationDir({
      manifest: { terminology: { completion: { manifest: RELEASE_COMMITTED }, sha256: "sha256:00" } },
    });
    const stub = vsacStub(vsacTable());

    const result = await run(verifyArgs(dir), { fetch: stub.fetch });

    assert.equal(result.code, 0, "without --verify-pin a mismatch is reported, not fatal");
    assert.match(result.stdout, /does NOT match the manifest pin/);
    assert.equal(stub.calls.length, 3);
    for (const call of stub.calls) {
      assert.equal(call.url.searchParams.get("manifest"), RELEASE_COMMITTED);
      assert.notEqual(call.url.searchParams.get("manifest"), DEFAULT_VSAC_MANIFEST);
    }
  });

  it("passes when the regenerated sidecar is the committed one (the positive control)", async () => {
    const { dir, sidecar } = await committedTranslation();

    const result = await run(verifyArgs(dir, "--verify-pin"), { fetch: vsacStub(vsacTable()).fetch });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1, "one summary line");
    assert.match(result.stdout, /3 value sets, 12 codes .*matches the manifest pin/);
    assert.equal(await readFile(join(dir, "terminology.json"), "utf8"), sidecar);
  });

  it("exits 1 on a pin mismatch, and still writes the file so it can be diffed", async () => {
    const { dir } = await committedTranslation();
    // VSAC moved one set since the block was committed: same release name, one more code.
    const moved = vsacTable();
    moved["9.9.2"] = { codes: codes("two", 6) };

    const result = await run(verifyArgs(dir, "--verify-pin"), { fetch: vsacStub(moved).fetch });

    assert.equal(result.code, 1, `a sidecar that no longer matches its pin must fail the deploy step; stdout: ${result.stdout}`);
    assert.match(result.stderr, /hashes to sha256:[0-9a-f]{64} but the manifest pins sha256:[0-9a-f]{64}/);
    assert.match(result.stderr, /was written anyway so it can be diffed/);
    const written = await readFile(join(dir, "terminology.json"), "utf8");
    assert.equal(
      JSON.parse(written).valueSets.find((v) => v.oid === "9.9.2").codes.length,
      6,
      "the file on disk must be the REGENERATED sidecar, so the mismatch can be diffed",
    );
  });
});

describe("the deploy path's constraints", () => {
  it("runs under plain `node` with no install, and the entry guard actually fires", async () => {
    // The Maui deploy invokes this exactly so. A guard that missed would exit 0 having done nothing —
    // so the assertion is on the REFUSAL, which only a running `main` can print. No manifest.json in the
    // fixture: a child process cannot take an injected transport, so if the key check ever stopped
    // firing first, the run must stop on the missing manifest rather than dial the live VSAC host.
    const dir = await translationDir();
    const env = { ...process.env };
    delete env.WORKWELL_VSAC_API_KEY;

    const outcome = await promisify(execFile)(process.execPath, [SCRIPT, "--catalog-id", "cms999", "--output-dir", dir], { env })
      .then(() => ({ code: 0, stderr: "" }))
      .catch((err) => ({ code: err.code, stderr: String(err.stderr) }));

    assert.equal(
      outcome.code,
      1,
      `a direct \`node\` run must reach main and refuse; exit ${outcome.code} with stderr "${outcome.stderr}"` +
        " means the entry guard did not fire (or the module did not load)",
    );
    assert.match(outcome.stderr, /WORKWELL_VSAC_API_KEY is unset/);
  });

  it("imports only node: built-ins and ./vsac-expansion.mjs, which itself imports nothing else", () => {
    for (const file of ["./vendor-derived-terminology.mjs", "./vsac-expansion.mjs"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
      for (const specifier of specifiers) {
        assert.ok(
          specifier.startsWith("node:") || specifier === "./vsac-expansion.mjs",
          `${file} imports ${specifier}, which a no-install deploy cannot resolve`,
        );
      }
      assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(/, `${file}: no dynamic imports either`);
    }
  });

  it("declaredValueSets walks EVERY library: the committed cms137 bundle declares 28, no single library does", () => {
    const committed = JSON.parse(readFileSync(new URL("../measures/official/cms137/bundle.json", import.meta.url), "utf8"));

    assert.equal(declaredValueSets(committed).length, 28);
    // Non-degeneracy: if one library declared all 28, a walk that stopped there would pass the line above.
    const perLibrary = committed.entry
      .filter((e) => e.resource.resourceType === "Library")
      .map((e) => declaredValueSets({ entry: [e] }).length);
    assert.ok(Math.max(...perLibrary) < 28, `largest single library declares ${Math.max(...perLibrary)}`);
  });

  it(".gitattributes keeps a translation's JSON byte-exact on a Windows checkout", () => {
    const lines = readFileSync(new URL("../.gitattributes", import.meta.url), "utf8").split(/\r?\n/).map((l) => l.trim());
    assert.ok(lines.includes("measures/derived/**/*.json -text"), "CRLF conversion would change every pinned hash");
  });
});
