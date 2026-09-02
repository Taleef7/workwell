/** Deployment-level subject noun (ROADMAP_2026-08-30 MM-0): the Maui pilot says
 *  "patient", TWH says "employee". Build-time config like every NEXT_PUBLIC_* var;
 *  default is employee so every existing deployment is byte-identical. */
export type SubjectTerm = {
  singular: string; plural: string; Singular: string; Plural: string;
  /** Indefinite article for the singular: "an employee", "a patient". */
  an: string;
  /** The evaluated population as a collective noun: "workforce", "patient population". */
  population: string;
  /** Clinical/measure domain description for landing/login copy. */
  domain: string;
};
const TERMS: Record<"employee" | "patient", SubjectTerm> = {
  employee: {
    singular: "employee", plural: "employees", Singular: "Employee", Plural: "Employees",
    an: "an", population: "workforce",
    domain: "OSHA safety and clinical wellness measures",
  },
  patient: {
    singular: "patient", plural: "patients", Singular: "Patient", Plural: "Patients",
    an: "a", population: "patient population",
    domain: "Primary care clinical quality measures",
  },
};
const raw = process.env.NEXT_PUBLIC_SUBJECT_TERM;
export const SUBJECT: SubjectTerm = TERMS[raw === "patient" ? "patient" : "employee"];
