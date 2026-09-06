import test from "node:test";
import assert from "node:assert/strict";
import { handleProviders } from "./providers.ts";
import { providers } from "../config/deployment-profile.ts";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const get = (url: string) => handleProviders(new Request(url));

test("GET /api/providers returns { id, name, location } for the profile's providers", async () => {
  const res = (await get("http://localhost/api/providers"))!;
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  assert.equal(rows.length, providers().length);
  for (const row of rows) {
    // Exactly these three keys: the filter matches on id, the select renders name and groups by
    // location. A field nothing reads is a field that drifts — `tenantId` is deliberately absent.
    assert.deepEqual(Object.keys(row).sort(), ["id", "location", "name"]);
    assert.ok(typeof row.id === "string" && row.id.length > 0);
  }
});

test("the list is sorted by location then name, so the select does not reshuffle", async () => {
  const rows = (await (await get("http://localhost/api/providers"))!.json()) as Array<{ name: string; location: string }>;
  const sorted = [...rows].sort((a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name));
  assert.deepEqual(rows, sorted);
});

test("the route declines anything that is not GET /api/providers", async () => {
  assert.equal(await handleProviders(new Request("http://localhost/api/providers", { method: "POST" })), null);
  assert.equal(await get("http://localhost/api/providers/maui-prov-001"), null);
  assert.equal(await get("http://localhost/api/tenants"), null);
});

test("on the Maui profile it returns the pilot's forty PCPs, and every filterable id resolves", () => {
  // A child process: the profile resolves at module load. The ids this returns are exactly the values
  // the roster's `providerId` filter matches on, so a mismatch here makes the select populate with
  // options that filter to nothing.
  const out = runProfileChild("maui", `
    const { handleProviders } = await import("./src/routes/providers.ts");
    const { employees } = await import("./src/config/deployment-profile.ts");
    const rows = await (await handleProviders(new Request("http://localhost/api/providers"))).json();
    const ids = new Set(rows.map((r) => r.id));
    console.log(JSON.stringify({
      count: rows.length,
      locations: [...new Set(rows.map((r) => r.location))].sort(),
      everyPanelResolves: employees().every((e) => ids.has(e.providerId)),
      sample: rows[0],
    }));
  `);
  assert.equal(out.count, 40);
  assert.deepEqual(out.locations, ["Kahului Clinic", "Kihei Clinic", "Lahaina Clinic", "Pukalani Clinic", "Wailuku Clinic"]);
  assert.equal(out.everyPanelResolves, true, "a patient is attributed to a PCP the select does not offer");
  assert.match(String((out.sample as { id: string }).id), /^maui-prov-\d{3}$/);
});
