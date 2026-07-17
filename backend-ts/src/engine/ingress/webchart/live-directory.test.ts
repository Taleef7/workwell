import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { EMPLOYEES } from "../../synthetic/employee-catalog.ts";
import {
  directoryForRows,
  profileForId,
  replaceLiveDirectory,
} from "./live-directory.ts";

afterEach(() => replaceLiveDirectory([]));

function bundle(...resources: unknown[]): unknown {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: resources.map((resource) => ({ resource })),
  };
}

test("replaceLiveDirectory maps the first Patient in each normalized bundle", () => {
  const profiles = replaceLiveDirectory([
    bundle(
      {
        resourceType: "Patient",
        id: "patient-17",
        name: [{ given: ["Amina", "Noor"], family: "Khan", text: "Fallback Display" }],
        birthDate: "1988-04-03",
      },
      { resourceType: "Patient", id: "ignored-second-patient", name: [{ given: ["Wrong"] }] },
    ),
  ]);

  assert.deepEqual(profiles, [
    {
      externalId: "wc|patient-17",
      name: "Amina Noor Khan",
      dateOfBirth: "1988-04-03",
      role: "employee",
      tenantId: "wc",
      site: "WebChart",
      providerId: "wc-provider-1",
    },
  ]);
  assert.deepEqual(profileForId("wc|patient-17"), profiles[0]);
});

test("replaceLiveDirectory uses trimmed HumanName.text when structured name parts are absent", () => {
  const [profile] = replaceLiveDirectory([
    bundle({ resourceType: "Patient", id: "patient-text", name: [{ text: "  Jane Doe  " }] }),
  ]);

  assert.equal(profile?.name, "Jane Doe");
});

test("replaceLiveDirectory atomically replaces the last-known-good registry", () => {
  replaceLiveDirectory([bundle({ resourceType: "Patient", id: "old", name: [{ given: ["Old"], family: "Name" }] })]);
  const before = directoryForRows([]);

  replaceLiveDirectory([bundle({ resourceType: "Patient", id: "new", name: [{ given: ["New"], family: "Name" }] })]);
  const after = directoryForRows([]);

  assert.equal(before.employeeById("wc|old")?.name, "Old Name", "existing snapshot keeps its complete registry");
  assert.equal(before.employeeById("wc|new")?.name, "new", "later ids are only minimal in the existing snapshot");
  assert.equal(after.employeeById("wc|old")?.name, "old", "removed cached ids fall back to minimal identity");
  assert.equal(after.employeeById("wc|new")?.name, "New Name");
});

test("directoryForRows merges static employees, cached profiles, and minimal wc row fallbacks", () => {
  replaceLiveDirectory([bundle({ resourceType: "Patient", id: "cached", name: [{ given: ["Cached"], family: "Person" }] })]);
  const snapshot = directoryForRows([{ subjectId: "wc|cached" }, { subjectId: "wc|restart-only" }]);

  assert.equal(snapshot.employees.length, EMPLOYEES.length + 2);
  assert.equal(snapshot.employeeById("emp-001")?.externalId, "emp-001");
  assert.equal(snapshot.employeeById("wc|cached")?.name, "Cached Person");
  assert.deepEqual(snapshot.employeeById("wc|restart-only"), {
    externalId: "wc|restart-only",
    name: "restart-only",
    role: "employee",
    tenantId: "wc",
    site: "WebChart",
    providerId: "wc-provider-1",
  });
  assert.equal(snapshot.providerById("wc-provider-1")?.name, "WebChart Clinician");
  assert.equal(snapshot.tenantById("wc")?.name, "WebChart");
  assert.equal(snapshot.enterpriseForTenant("wc")?.tenantId, "wc");
  assert.equal(profileForId("wc|not-cached")?.name, "not-cached");
  assert.equal(profileForId("not-webchart"), null);
});

test("directoryForRows is byte/deep identical to the static directory when no live rows are present", () => {
  replaceLiveDirectory([]);
  const snapshot = directoryForRows([]);
  assert.strictEqual(snapshot.employees, EMPLOYEES);
  assert.deepEqual(snapshot.employees, EMPLOYEES);
});
