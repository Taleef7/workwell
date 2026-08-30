import { afterEach, describe, expect, it, vi } from "vitest";

async function loadWith(term: string | undefined) {
  vi.resetModules();
  if (term === undefined) {
    // Truly unset — deleting beats stubbing "" because the two are different env states.
    vi.stubEnv("NEXT_PUBLIC_SUBJECT_TERM", "");
    delete process.env.NEXT_PUBLIC_SUBJECT_TERM;
  } else {
    vi.stubEnv("NEXT_PUBLIC_SUBJECT_TERM", term);
  }
  return await import("@/lib/terminology");
}
afterEach(() => vi.unstubAllEnvs());

const EMPLOYEE_TERMS = {
  singular: "employee",
  plural: "employees",
  Singular: "Employee",
  Plural: "Employees",
  an: "an",
  population: "workforce",
};

describe("terminology", () => {
  it("defaults to the full employee term set when the env var is unset", async () => {
    const t = await loadWith(undefined);
    expect(t.SUBJECT).toEqual(EMPLOYEE_TERMS);
  });
  it("defaults to employee on an empty value", async () => {
    const t = await loadWith("");
    expect(t.SUBJECT).toEqual(EMPLOYEE_TERMS);
  });
  it("switches every form to patient", async () => {
    const t = await loadWith("patient");
    expect(t.SUBJECT).toEqual({
      singular: "patient",
      plural: "patients",
      Singular: "Patient",
      Plural: "Patients",
      an: "a",
      population: "patient population",
    });
  });
  it("falls back to employee on an unknown value", async () => {
    const t = await loadWith("astronaut");
    expect(t.SUBJECT).toEqual(EMPLOYEE_TERMS);
  });
});
