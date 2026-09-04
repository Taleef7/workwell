import type { SubjectTerm } from "@/lib/terminology";

const EMPLOYEE_SUBJECT: SubjectTerm = {
  singular: "employee",
  plural: "employees",
  Singular: "Employee",
  Plural: "Employees",
  an: "an",
  population: "workforce",
  domain: "OSHA safety and clinical wellness measures",
};

const PATIENT_SUBJECT: SubjectTerm = {
  singular: "patient",
  plural: "patients",
  Singular: "Patient",
  Plural: "Patients",
  an: "a",
  population: "patient population",
  domain: "Primary care clinical quality measures",
};

export const subject: SubjectTerm = {
  singular: "employee",
  plural: "employees",
  Singular: "Employee",
  Plural: "Employees",
  an: "an",
  population: "workforce",
  domain: "OSHA safety and clinical wellness measures",
};

export function setSubject(term: "employee" | "patient"): void {
  Object.assign(subject, term === "patient" ? PATIENT_SUBJECT : EMPLOYEE_SUBJECT);
}
