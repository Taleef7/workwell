import { describe, expect, it, vi } from "vitest";

const subject = vi.hoisted(() => ({ plural: "employees" }));
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

import { subjectPath } from "./subject-path";

describe("subjectPath (#648)", () => {
  it("names the subject page for the deployment: /patients on a patient deployment", () => {
    subject.plural = "patients";
    expect(subjectPath("pat-04403")).toBe("/patients/pat-04403");
  });

  it("keeps /employees on an employee deployment", () => {
    subject.plural = "employees";
    expect(subjectPath("emp-006")).toBe("/employees/emp-006");
  });

  it("encodes the id, so an id with a slash or space stays one path segment", () => {
    subject.plural = "patients";
    expect(subjectPath("a/b c")).toBe("/patients/a%2Fb%20c");
  });
});
