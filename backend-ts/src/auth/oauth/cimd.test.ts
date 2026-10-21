/**
 * Fetching client metadata documents under the SSRF fence (MCP OAuth, CIMD).
 *   node --import tsx --test src/auth/oauth/cimd.test.ts
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { LookupAddress } from "node:dns";
import { CimdError, __clearCimdCache, cimdUrlProblem, cleanClientName, fetchClientMetadata, guardedLookup, type CimdDeps } from "./cimd.ts";

const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
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
  await assert.rejects(fetchClientMetadata("https://metadata.attacker.example/client.json", { lookup: toLoopback }), /refused address/);
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
