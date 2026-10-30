import test from "node:test";
import assert from "node:assert/strict";
import { handleProviders, linkedProviderOf } from "./providers.ts";
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

test("the route declines anything that is not GET /api/providers or /api/providers/mine", async () => {
  assert.equal(await handleProviders(new Request("http://localhost/api/providers", { method: "POST" })), null);
  assert.equal(await handleProviders(new Request("http://localhost/api/providers/mine", { method: "POST" })), null);
  assert.equal(await get("http://localhost/api/providers/maui-prov-001"), null);
  assert.equal(await get("http://localhost/api/providers/mine/x"), null);
  assert.equal(await get("http://localhost/api/tenants"), null);
});

test("/mine on the default profile: no account is linked, the public viewer included (#870)", async () => {
  for (const actor of ["viewer@workwell.dev", "cm@workwell.dev", "clinician@maui.workwell.dev", undefined]) {
    const res = (await handleProviders(new Request("http://localhost/api/providers/mine"), undefined, actor))!;
    assert.equal(res.status, 200);
    // The clinician seat is refused off its own profile, so its link resolves to nothing here.
    assert.deepEqual(await res.json(), { provider: null }, String(actor));
  }
});

test("a link counts only on a VIEWER record, whatever else carries a providerId (#870)", () => {
  const users = [
    { email: "lead@x.dev", role: "ROLE_CASE_MANAGER", passwordHash: "x", providerId: providers()[0]!.id },
    { email: "seat@x.dev", role: "ROLE_VIEWER", passwordHash: "x", providerId: providers()[0]!.id },
    { email: "gone@x.dev", role: "ROLE_VIEWER", passwordHash: "x", providerId: "no-such-provider" },
  ];
  assert.equal(linkedProviderOf("lead@x.dev", undefined, users), null, "a case manager's 'mine' is their panels");
  assert.deepEqual(Object.keys(linkedProviderOf("SEAT@x.dev ", undefined, users)!).sort(), ["id", "location", "name"]);
  assert.equal(linkedProviderOf("gone@x.dev", undefined, users), null, "a provider the directory no longer lists");
  assert.equal(linkedProviderOf("nobody@x.dev", undefined, users), null);
});

test("on the Maui profile the clinician seat is linked to a listed provider, and no other account is (#870)", () => {
  const out = runProfileChild("maui", `
    const { handleProviders, linkedProviderOf } = await import("./src/routes/providers.ts");
    const { DEMO_USERS } = await import("./src/auth/demo-users.ts");
    const { providerById } = await import("./src/config/deployment-profile.ts");
    const mine = async (actor) => (await handleProviders(new Request("http://localhost/api/providers/mine"), undefined, actor)).json();
    console.log(JSON.stringify({
      clinician: await mine("clinician@maui.workwell.dev"),
      staff: await mine("quality-staff@maui.workwell.dev"),
      lead: await mine("quality-lead@maui.workwell.dev"),
      admin: await mine("admin@maui.workwell.dev"),
      everyLinkResolves: DEMO_USERS.filter((u) => u.providerId).every((u) => providerById(u.providerId) !== null),
      linked: DEMO_USERS.filter((u) => linkedProviderOf(u.email)).map((u) => u.email),
    }));
  `);
  assert.deepEqual(out.clinician, { provider: { id: "maui-prov-011", name: "Dr. Ana Silva", location: "Wailuku Clinic" } });
  for (const seat of ["staff", "lead", "admin"]) assert.deepEqual(out[seat], { provider: null }, seat);
  assert.equal(out.everyLinkResolves, true, "a seat linked to a provider the directory does not list");
  assert.deepEqual(out.linked, ["clinician@maui.workwell.dev"]);
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
