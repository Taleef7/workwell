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

export type TraceabilityValueSetRef = {
  name: string;
  oid: string;
  version: string;
};

export type TestFixtureRef = {
  fixtureName: string;
  expectedOutcome: string;
};

export type TraceabilityRow = {
  policyCitation: string;
  policyRequirement: string;
  specField: string;
  specValue: string;
  cqlDefine: string;
  cqlSnippet: string;
  valueSets: TraceabilityValueSetRef[];
  requiredDataElements: string[];
  testFixtures: TestFixtureRef[];
  runtimeEvidenceKeys: string[];
};

export type TraceabilityGap = {
  severity: "ERROR" | "WARN" | string;
  message: string;
};

export type TraceabilityResponse = {
  measureId: string;
  measureVersionId: string;
  measureName: string;
  version: string;
  rows: TraceabilityRow[];
  gaps: TraceabilityGap[];
};

export type CaseImpact = {
  wouldCreate: number;
  wouldUpdate: number;
  wouldClose: number;
  wouldExclude: number;
};

export type ImpactPreviewResponse = {
  measureId: string;
  measureVersionId: string;
  evaluationDate: string;
  populationEvaluated: number;
  outcomeCounts: Record<string, number>;
  caseImpact: CaseImpact;
  siteBreakdown: Record<string, unknown>[];
  roleBreakdown: Record<string, unknown>[];
  warnings: string[];
};

export type DataElementMapping = {
  id: string;
  sourceId: string;
  sourceDisplayName: string;
  sourceType: string;
  canonicalElement: string;
  sourceField: string;
  fhirResourceType: string | null;
  fhirPath: string | null;
  codeSystem: string | null;
  mappingStatus: string;
  lastValidatedAt: string | null;
  notes: string | null;
};

export type RequiredElementReadiness = {
  canonicalElement: string;
  label: string;
  sourceId: string | null;
  mappingStatus: string;
  freshnessStatus: string;
  missingnessRate: number;
  sampleMissingEmployees: string[];
};

export type DataReadinessResponse = {
  overallStatus: string;
  requiredElements: RequiredElementReadiness[];
  blockers: string[];
  warnings: string[];
};

export type ValueSetCodeEntry = {
  code: string;
  display: string;
  system: string;
};

export type ValueSetDetail = {
  id: string;
  oid: string;
  name: string;
  version: string;
  lastResolvedAt: string | null;
  canonicalUrl: string;
  source: string;
  governanceStatus: string;
  resolutionStatus: string;
  resolutionError: string;
  expansionHash: string;
  codeCount: number;
  codeSystems: string[];
  codes: ValueSetCodeEntry[];
};

export type ValueSetCheckItem = {
  id: string;
  name: string;
  oid: string;
  version: string;
  resolutionStatus: string;
  codeCount: number;
  warnings: string[];
  blocker: boolean;
};

export type ResolveCheckResponse = {
  measureId: string;
  measureVersionId: string;
  allResolved: boolean;
  valueSets: ValueSetCheckItem[];
  blockers: string[];
  warnings: string[];
};

export type AffectedMeasure = {
  measureId: string;
  measureName: string;
  version: string;
};

export type ValueSetDiffResponse = {
  fromId: string;
  fromName: string;
  fromVersion: string;
  toId: string;
  toName: string;
  toVersion: string;
  addedCodes: ValueSetCodeEntry[];
  removedCodes: ValueSetCodeEntry[];
  affectedMeasures: AffectedMeasure[];
  warnings: string[];
};

export type TerminologyMapping = {
  id: string;
  localCode: string;
  localDisplay: string | null;
  localSystem: string;
  standardCode: string;
  standardDisplay: string | null;
  standardSystem: string;
  mappingStatus: string;
  mappingConfidence: number | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  notes: string | null;
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
