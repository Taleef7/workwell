import type { OshaReferenceOption } from "@/components/osha-reference-combobox";

export type MeasureDetail = {
  id: string;
  name: string;
  policyRef: string;
  oshaReferenceId: string | null;
  version: string;
  status: "Draft" | "Approved" | "Active" | "Deprecated" | string;
  owner: string;
  description: string;
  eligibilityCriteria: {
    roleFilter: string;
    siteFilter: string;
    programEnrollmentText: string;
  };
  exclusions: Array<{ label: string; criteriaText: string }>;
  complianceWindow: string;
  requiredDataElements: string[];
  cqlText: string;
  compileStatus: "COMPILED" | "ERROR" | string;
  valueSets: ValueSetRef[];
  testFixtures: TestFixture[];
};

export type ValueSetRef = {
  id: string;
  oid: string;
  name: string;
  version: string;
  resolvabilityStatus: "RESOLVED" | "UNRESOLVED" | string;
  resolvabilityLabel: string;
  resolvabilityNote: string;
  codeCount: number;
};

export type OshaReference = OshaReferenceOption;

export type TestFixture = {
  fixtureName: string;
  employeeExternalId: string;
  expectedOutcome: string;
  notes: string;
};

export type ActivationReadiness = {
  ready: boolean;
  compileStatus: string;
  testFixtureCount: number;
  valueSetCount: number;
  testValidationPassed: boolean;
  activationBlockers: string[];
};

export type VersionHistoryItem = {
  id: string;
  version: string;
  status: "Draft" | "Approved" | "Active" | "Deprecated" | string;
  author: string;
  createdAt: string;
  changeSummary: string;
};

export type DraftSpecResponse = {
  success: boolean;
  fallback?: string | null;
  suggestion: {
    description?: string;
    eligibilityCriteria?: {
      roleFilter?: string;
      siteFilter?: string;
      programEnrollmentText?: string;
    };
    exclusions?: Array<{ label?: string; criteriaText?: string }>;
    complianceWindow?: string;
    requiredDataElements?: string[];
  };
};
