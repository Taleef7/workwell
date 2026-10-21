/**
 * Fetching client metadata documents under the SSRF fence (MCP OAuth, CIMD).
 *   node --import tsx --test src/auth/oauth/cimd.test.ts
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { LookupAddress } from "node:dns";
import { CimdError, DEFAULT_CIMD_CLIENTS, __clearCimdCache, cimdClientsFrom, cimdUrlProblem, cleanClientName, fetchClientMetadata, guardedLookup, type CimdDeps } from "./cimd.ts";

const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
/** Test-made client ids are accepted only when a test lists them, as the deployment's setting would. */
const allow = (...ids: string[]) => ({ allowedClients: [CLAUDE_CODE, ...ids] });
const DOC = { client_id: CLAUDE_CODE, client_name: "Claude Code", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"], token_endpoint_auth_method: "none" };

beforeEach(() => __clearCimdCache());

/** A fake https.request: answers with `status`, `headers` and the body chunks, unless `hang`. */
function fakeRequest(answer: { status?: number; headers?: Record<string, string>; chunks?: string[]; hang?: boolean }) {
  const calls: URL[] = [];
  const request: NonNullable<CimdDeps["request"]> = (url, _options, onResponse) => {
    calls.push(url);
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void; destroyed?: boolean };
    req.destroy = () => {
      req.destroyed = true;
    };
    req.end = () => {
      if (answer.hang) return;
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; resume: () => void };
      res.statusCode = answer.status ?? 200;
      res.headers = answer.headers ?? {};
      res.resume = () => {};
      setImmediate(() => {
        onResponse(res as never);
        for (const chunk of answer.chunks ?? []) {
          if (req.destroyed) return;
          res.emit("data", Buffer.from(chunk));
        }
        if (!req.destroyed) res.emit("end");
      });
    };
    return req as never;
  };
  return { request, calls };
}

test("a client_id must be a normalized https URL with a path, on 443, naming a host", () => {
  assert.equal(cimdUrlProblem(CLAUDE_CODE), null);
  for (const raw of [
    "http://claude.ai/meta", "https://claude.ai", "https://claude.ai/", "https://claude.ai:8443/meta", "https://u:p@claude.ai/meta",
    "https://claude.ai/meta#x", "https://127.0.0.1/meta", "https://[::1]/meta", "https://claude.ai/a/../meta", "https://CLAUDE.ai/meta", "not a url",
  ]) {
    assert.notEqual(cimdUrlProblem(raw), null, raw);
  }
});

test("the lookup refuses a host if any address it resolves to is internal", async () => {
  const lookupOf = (addresses: LookupAddress[]) => ((_h: string, _o: unknown, cb: (e: null, a: LookupAddress[]) => void) => cb(null, addresses)) as never;
  const resolve = (addresses: LookupAddress[], all: boolean) =>
    new Promise<unknown>((ok, fail) => (guardedLookup(lookupOf(addresses)) as unknown as (h: string, o: object, cb: (e: Error | null, a?: unknown) => void) => void)("x.example", { all }, (e, a) => (e ? fail(e) : ok(a))));
  await assert.rejects(resolve([{ address: "169.254.169.254", family: 4 }], true), CimdError);
  await assert.rejects(resolve([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }], true), CimdError, "one internal address is enough");
  await assert.rejects(resolve([{ address: "::ffff:127.0.0.1", family: 6 }], false), CimdError);
  assert.deepEqual(await resolve([{ address: "93.184.216.34", family: 4 }], true), [{ address: "93.184.216.34", family: 4 }]);
  assert.equal(await resolve([{ address: "93.184.216.34", family: 4 }], false), "93.184.216.34");
});

test("the real https request uses the guarded lookup: a name resolving to loopback is refused before any connection", async () => {
  const toLoopback = ((_h: string, _o: unknown, cb: (e: null, a: LookupAddress[]) => void) => cb(null, [{ address: "127.0.0.1", family: 4 }])) as never;
  await assert.rejects(fetchClientMetadata("https://metadata.attacker.example/client.json", { lookup: toLoopback, ...allow("https://metadata.attacker.example/client.json") }), /refused address/);
});

test("a valid document is returned with its host, and cached by max-age", async () => {
  const fake = fakeRequest({ headers: { "cache-control": "max-age=600" }, chunks: [JSON.stringify(DOC)] });
  let now = 1_000_000;
  const deps = { request: fake.request, now: () => now };
  const meta = await fetchClientMetadata(CLAUDE_CODE, deps);
  assert.deepEqual(meta, { clientId: CLAUDE_CODE, clientName: "Claude Code", redirectUris: DOC.redirect_uris, host: "claude.ai" });
  await fetchClientMetadata(CLAUDE_CODE, deps);
  assert.equal(fake.calls.length, 1, "served from the cache");
  now += 601_000;
  await fetchClientMetadata(CLAUDE_CODE, deps);
  assert.equal(fake.calls.length, 2, "fetched again after max-age");
});

test("a redirect, an oversized body, a slow server and a bad document are refused, and a failure is negatively cached", async () => {
  await assert.rejects(fetchClientMetadata(CLAUDE_CODE, { request: fakeRequest({ status: 302, headers: { location: "http://169.254.169.254/" } }).request }), /redirects are not followed/);
  __clearCimdCache();
  await assert.rejects(fetchClientMetadata(CLAUDE_CODE, { request: fakeRequest({ chunks: ["x".repeat(40_000), "x".repeat(40_000)] }).request }), /64 KB/);
  __clearCimdCache();
  await assert.rejects(fetchClientMetadata(CLAUDE_CODE, { request: fakeRequest({ hang: true }).request, timeoutMs: 20 }), /longer than 5 s/);
  __clearCimdCache();
  const bad = (doc: unknown) => fetchClientMetadata(CLAUDE_CODE, { request: fakeRequest({ chunks: [JSON.stringify(doc)] }).request }).finally(__clearCimdCache);
  await assert.rejects(bad({ ...DOC, client_id: "https://claude.ai/oauth/other" }), /does not name this client_id/);
  await assert.rejects(bad({ ...DOC, client_name: "‮\u0000" }), /no client_name/);
  await assert.rejects(bad({ ...DOC, token_endpoint_auth_method: "private_key_jwt" }), /public clients/);
  await assert.rejects(bad({ ...DOC, redirect_uris: ["http://evil.example/cb"] }), /refused redirect URI/);
  await assert.rejects(bad({ ...DOC, redirect_uris: [] }), /needs redirect_uris/);

  const failing = fakeRequest({ status: 500 });
  await assert.rejects(fetchClientMetadata(CLAUDE_CODE, { request: failing.request }));
  await assert.rejects(fetchClientMetadata(CLAUDE_CODE, { request: failing.request }));
  assert.equal(failing.calls.length, 1, "the second attempt is answered from the negative cache");
});

test("a client name loses control and direction-override characters and is capped", () => {
  assert.equal(cleanClientName("Cl‮aude\u0007"), "Claude");
  assert.equal(cleanClientName("x".repeat(100))!.length, 64);
  assert.equal(cleanClientName(42), null);
});

// A host alone would not do: every new path on claude.ai is a new URL, and each would spend the shared fetch
// budget, so a stranger sending random paths could lock the real clients out.
test("only an accepted client's document is fetched; any other client_id, on any host, is refused before a request", async () => {
  const fake = fakeRequest({ chunks: [JSON.stringify(DOC)] });
  for (const id of ["https://evil.example/client.json", "https://claude.ai/oauth/random-1", "https://claude.ai/x?n=1", "https://sub.claude.ai/oauth/claude-code-client-metadata"]) {
    await assert.rejects(fetchClientMetadata(id, { request: fake.request }), /not an accepted client/, id);
  }
  assert.equal(fake.calls.length, 0, "no request was made, so nothing was spent");
  assert.equal((await fetchClientMetadata(CLAUDE_CODE, { request: fake.request })).clientName, "Claude Code", "the real one still works");
  await assert.rejects(fetchClientMetadata(CLAUDE_CODE, { request: fake.request, allowedClients: ["https://mcp.example/client.json"] }), /not an accepted client/);

  assert.deepEqual(cimdClientsFrom(undefined), [...DEFAULT_CIMD_CLIENTS]);
  assert.deepEqual(cimdClientsFrom(" , "), [...DEFAULT_CIMD_CLIENTS]);
  assert.deepEqual(cimdClientsFrom("https://mcp.example/c.json, http://bad.example/c, https://CLAUDE.ai/x"), ["https://mcp.example/c.json"], "an entry that could never match is dropped");
  assert.deepEqual(DEFAULT_CIMD_CLIENTS, ["https://claude.ai/oauth/mcp-oauth-client-metadata", "https://claude.ai/oauth/claude-code-client-metadata"]);
});

test("the attack the allowlist stops: random claude.ai paths spend nothing, and the real client still signs in on a cold cache", async () => {
  const fake = fakeRequest({ chunks: [JSON.stringify(DOC)] });
  for (let i = 0; i < 50; i++) await assert.rejects(fetchClientMetadata(`https://claude.ai/x-${i}`, { request: fake.request }));
  assert.equal(fake.calls.length, 0);
  assert.equal((await fetchClientMetadata(CLAUDE_CODE, { request: fake.request })).clientName, "Claude Code");
});

test("concurrent requests for one document share one fetch", async () => {
  const fake = fakeRequest({ chunks: [JSON.stringify(DOC)] });
  const all = await Promise.all(Array.from({ length: 10 }, () => fetchClientMetadata(CLAUDE_CODE, { request: fake.request })));
  assert.equal(fake.calls.length, 1);
  assert.ok(all.every((m) => m.clientName === "Claude Code"));
});

test("failures never push a good document out of the cache", async () => {
  let now = 1_000_000;
  const good = fakeRequest({ headers: { "cache-control": "max-age=3600" }, chunks: [JSON.stringify(DOC)] });
  await fetchClientMetadata(CLAUDE_CODE, { request: good.request, now: () => now });
  const failing = fakeRequest({ status: 404 });
  const missing = Array.from({ length: 300 }, (_, i) => `https://claude.ai/missing-${i}`);
  for (const id of missing) {
    now += 4_000; // under the per-minute budget
    await assert.rejects(fetchClientMetadata(id, { request: failing.request, now: () => now, ...allow(...missing) }));
  }
  assert.equal(failing.calls.length, 300);
  await fetchClientMetadata(CLAUDE_CODE, { request: good.request, now: () => now });
  assert.equal(good.calls.length, 1, "still served from the cache");
});

test("at most 4 fetches in flight and 20 a minute; a refusal for load is not remembered as the answer", async () => {
  const ids = [...Array.from({ length: 4 }, (_, i) => `https://claude.ai/slow-${i}`), "https://claude.ai/fifth", ...Array.from({ length: 21 }, (_, i) => `https://claude.ai/m-${i}`)];
  const hanging = fakeRequest({ hang: true });
  const slow = ids.slice(0, 4).map((id) => fetchClientMetadata(id, { request: hanging.request, timeoutMs: 50, ...allow(...ids) }));
  await assert.rejects(fetchClientMetadata("https://claude.ai/fifth", { request: hanging.request, timeoutMs: 50, ...allow(...ids) }), /too many/);
  assert.equal(hanging.calls.length, 4);
  await Promise.allSettled(slow);
  const fine = fakeRequest({ chunks: [JSON.stringify({ ...DOC, client_id: "https://claude.ai/fifth" })] });
  assert.equal((await fetchClientMetadata("https://claude.ai/fifth", { request: fine.request, ...allow(...ids) })).clientId, "https://claude.ai/fifth", "fetched once there was room");

  __clearCimdCache();
  let now = 5_000_000;
  const failing = fakeRequest({ status: 404 });
  for (let i = 0; i < 20; i++) await assert.rejects(fetchClientMetadata(`https://claude.ai/m-${i}`, { request: failing.request, now: () => now, ...allow(...ids) }), /404/);
  await assert.rejects(fetchClientMetadata("https://claude.ai/m-20", { request: failing.request, now: () => now, ...allow(...ids) }), /too many/);
  assert.equal(failing.calls.length, 20, "the 21st in a minute was not fetched");
  now += 60_000;
  await assert.rejects(fetchClientMetadata("https://claude.ai/m-20", { request: failing.request, now: () => now, ...allow(...ids) }), /404/);
});

test("the last good document stands in when the publisher cannot answer, but not when it answers no", async () => {
  let now = 9_000_000;
  const good = fakeRequest({ headers: { "cache-control": "max-age=60" }, chunks: [JSON.stringify(DOC)] });
  await fetchClientMetadata(CLAUDE_CODE, { request: good.request, now: () => now });
  now += 120_000;
  // 403 too: a CDN's bot check on a datacenter address is the likeliest real failure.
  for (const status of [503, 429, 403]) {
    now += 61_000; // past the minute a stale answer waits before asking again
    assert.equal((await fetchClientMetadata(CLAUDE_CODE, { request: fakeRequest({ status }).request, now: () => now })).clientName, "Claude Code", String(status));
  }
  now += 61_000;
  assert.equal((await fetchClientMetadata(CLAUDE_CODE, { request: fakeRequest({ hang: true }).request, timeoutMs: 20, now: () => now })).clientName, "Claude Code", "a timeout");

  // While serving the stale copy, the publisher is asked again a minute later, not on every sign-in.
  const down = fakeRequest({ status: 503 });
  now += 61_000;
  await fetchClientMetadata(CLAUDE_CODE, { request: down.request, now: () => now });
  now += 30_000;
  await fetchClientMetadata(CLAUDE_CODE, { request: down.request, now: () => now });
  assert.equal(down.calls.length, 1, "the second sign-in did not wait on the publisher");

  now += 61_000;
  await assert.rejects(fetchClientMetadata(CLAUDE_CODE, { request: fakeRequest({ status: 404 }).request, now: () => now }), /404/, "a withdrawn document is the answer");
  __clearCimdCache();
  await fetchClientMetadata(CLAUDE_CODE, { request: good.request, now: () => now });
  now += 2 * 86_400_000;
  await assert.rejects(fetchClientMetadata(CLAUDE_CODE, { request: fakeRequest({ status: 503 }).request, now: () => now }), /503/, "not after a day");
});

test("a failure that may pass is remembered for seconds, a refusal for a minute", async () => {
  let now = 20_000_000;
  const flaky = fakeRequest({ status: 503 });
  await assert.rejects(fetchClientMetadata(CLAUDE_CODE, { request: flaky.request, now: () => now }), /503/);
  now += 6_000;
  const back = fakeRequest({ chunks: [JSON.stringify(DOC)] });
  assert.equal((await fetchClientMetadata(CLAUDE_CODE, { request: back.request, now: () => now })).clientName, "Claude Code", "a blip on a cold cache blocks sign-in for seconds, not a minute");

  __clearCimdCache();
  const gone = fakeRequest({ status: 404 });
  await assert.rejects(fetchClientMetadata(CLAUDE_CODE, { request: gone.request, now: () => now }), /404/);
  now += 6_000;
  await assert.rejects(fetchClientMetadata(CLAUDE_CODE, { request: gone.request, now: () => now }), /404/);
  assert.equal(gone.calls.length, 1, "a 404 is the answer for a minute");
});

test("serving the stale copy never lengthens its day: a day after the last good fetch it is gone", async () => {
  let now = 30_000_000;
  await fetchClientMetadata(CLAUDE_CODE, { request: fakeRequest({ headers: { "cache-control": "max-age=60" }, chunks: [JSON.stringify(DOC)] }).request, now: () => now });
  const down = fakeRequest({ status: 503 });
  for (const hours of [6, 12, 18]) {
    now = 30_000_000 + hours * 3_600_000;
    assert.equal((await fetchClientMetadata(CLAUDE_CODE, { request: down.request, now: () => now })).clientName, "Claude Code", `${hours} h`);
  }
  now = 30_000_000 + 25 * 3_600_000;
  await assert.rejects(fetchClientMetadata(CLAUDE_CODE, { request: down.request, now: () => now }), /503/);
});
