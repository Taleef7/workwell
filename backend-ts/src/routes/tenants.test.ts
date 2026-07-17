/**
 * Tenants route (#185 E13 PR-1): GET /api/tenants lists both WebChart systems.
 *   node --import tsx --test src/routes/tenants.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleTenants } from "./tenants.ts";

test("GET /api/tenants lists the live tenants + the mhn scale tenant", async () => {
  const res = (await handleTenants(new Request("http://x/api/tenants", { method: "GET" })))!;
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string; name: string }[];
  assert.deepEqual(body.map((t) => t.id).sort(), ["ihn", "mhn", "twh"]);
  assert.ok(body.every((t) => typeof t.name === "string" && t.name.length > 0));
});

test("non-matching path → null (not handled)", async () => {
  assert.equal(await handleTenants(new Request("http://x/api/other", { method: "GET" })), null);
});

test("POST → null", async () => {
  assert.equal(await handleTenants(new Request("http://x/api/tenants", { method: "POST" })), null);
});

test("GET /api/tenants adds the host-labelled wc tenant only when WebChart is configured", async () => {
  const req = new Request("http://x/api/tenants", { method: "GET" });
  const off = await handleTenants(req, {});
  const original = await handleTenants(new Request(req), undefined);
  assert.equal(await off!.text(), await original!.text(), "seam-off response bytes stay identical");

  const configured = await handleTenants(new Request(req), {
    WORKWELL_WEBCHART_BASE_URL: "http://localhost:8081",
    WORKWELL_WEBCHART_API_KEY: "local-dev",
  });
  const body = (await configured!.json()) as { id: string; name: string }[];
  assert.deepEqual(body.at(-1), { id: "wc", name: "WebChart (localhost:8081)" });
  assert.equal(body.filter((tenant) => tenant.id === "wc").length, 1);
});
