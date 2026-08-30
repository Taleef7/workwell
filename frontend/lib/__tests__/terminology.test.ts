import { afterEach, describe, expect, it, vi } from "vitest";

async function loadWith(term: string | undefined) {
  vi.resetModules();
  if (term === undefined) vi.stubEnv("NEXT_PUBLIC_SUBJECT_TERM", "");
  else vi.stubEnv("NEXT_PUBLIC_SUBJECT_TERM", term);
  return await import("@/lib/terminology");
}
afterEach(() => vi.unstubAllEnvs());

describe("terminology", () => {
  it("defaults to employee", async () => {
    const t = await loadWith(undefined);
    expect(t.SUBJECT.singular).toBe("employee");
    expect(t.SUBJECT.Plural).toBe("Employees");
  });
  it("switches every form to patient", async () => {
    const t = await loadWith("patient");
    expect(t.SUBJECT).toEqual({
      singular: "patient",
      plural: "patients",
      Singular: "Patient",
      Plural: "Patients",
    });
  });
  it("falls back to employee on an unknown value", async () => {
    const t = await loadWith("astronaut");
    expect(t.SUBJECT.singular).toBe("employee");
  });
});
