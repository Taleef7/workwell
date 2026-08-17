/**
 * CDS Hooks 2.0.1 wire types (ADR-067) — the shapes WorkWell PRODUCES, and nothing else.
 *
 * Normative reference: https://cds-hooks.hl7.org/2.0/ (HL7 balloted STU2, package
 * `hl7.fhir.uv.cds-hooks#2.0.1`). NOT `cds-hooks.org`, which serves a draft CI build.
 *
 * ## Why these are hand-written rather than imported
 *
 * There is no canonical npm types package for CDS Hooks — everything on npm named `cds-*-types` is SAP
 * Core Data Services, an unrelated name collision. The best existing TS model is Medplum's
 * `packages/core/src/cds.ts` (Apache-2.0), and these interfaces follow its shape; depending on
 * `@medplum/core` for ~150 lines of interfaces would be a new dependency for nothing (CLAUDE.md hard rule).
 *
 * ## Deliberately absent, because we never emit them
 *
 * - `systemActions` — actions a client auto-applies with no user interaction. WorkWell is SUPPLEMENTARY to
 *   WebChart (locked decision 1) and "AI never decides compliance" has a sibling here: nothing WorkWell
 *   returns should change a chart without a human choosing it. See docs/AI_GUARDRAILS.md.
 * - `overrideReasons` — offering a coded dismissal vocabulary we do not analyse would be decoration.
 * - `update`/`delete` actions, `smart`/`questionnaire` links, `appContext`, `source.topic` — unused.
 *
 * Adding any of them is a deliberate change, not a fill-in-the-blank.
 */

/** One service in the discovery response. `prefetch` is deliberately never declared — see `discovery.ts`. */
export interface CdsService {
  /** The hook this service is invoked on, e.g. `patient-view`. */
  hook: string;
  /** The `{id}` in `POST /cds-services/{id}`. */
  id: string;
  title: string;
  description: string;
  /** Spec-defined field for stating what a caller must know. We use it to state what we do NOT do. */
  usageRequirements: string;
}

export interface CdsDiscoveryResponse {
  services: CdsService[];
}

/** The hook context WorkWell reads. `patient-view` also defines `encounterId` (OPTIONAL); we ignore it. */
export interface CdsRequestContext {
  userId?: string;
  patientId?: string;
  encounterId?: string;
}

/**
 * An invocation. `fhirServer`, `fhirAuthorization` and `prefetch` are accepted and NOT evaluated — the
 * service declares that in `usageRequirements`, which is the honest place for it. They are typed as
 * `unknown` precisely so no code can start depending on them without changing this file.
 */
export interface CdsRequest {
  hook?: string;
  hookInstance?: string;
  fhirServer?: unknown;
  fhirAuthorization?: unknown;
  prefetch?: unknown;
  context?: CdsRequestContext;
}

export interface CdsSource {
  label: string;
  url?: string;
}

export interface CdsCreateAction {
  type: "create";
  description: string;
  /** A FHIR resource. `unknown` because `toServiceRequest` returns `unknown` (no FHIR runtime dep). */
  resource: unknown;
}

export interface CdsSuggestion {
  label: string;
  uuid: string;
  actions: CdsCreateAction[];
}

export interface CdsLink {
  label: string;
  url: string;
  type: "absolute";
}

/**
 * A card. `indicator` is `info | warning | critical` in the spec; **`critical` is deliberately
 * unrepresentable here** — in CDS Hooks it means the user must not proceed, which WorkWell is not
 * entitled to say about a WebChart encounter (locked decision 1). Making it a type error rather than a
 * convention means the refusal cannot be forgotten.
 */
export interface CdsCard {
  /** REQUIRED, and the spec caps it at 140 characters. */
  summary: string;
  indicator: "info" | "warning";
  source: CdsSource;
  detail?: string;
  /** Needed for the feedback endpoint to identify this card. Deterministic — see `cardUuid`. */
  uuid?: string;
  links?: CdsLink[];
  suggestions?: CdsSuggestion[];
  /** REQUIRED by the spec whenever `suggestions` is present. */
  selectionBehavior?: "at-most-one" | "any";
}

export interface CdsResponse {
  cards: CdsCard[];
}

/** `POST /cds-services/{id}/feedback`. `outcome` is `accepted | overridden` — there is no `declined`. */
export interface CdsFeedbackEntry {
  card?: string;
  outcome?: string;
  /** REQUIRED by the spec when `outcome` is `accepted`. */
  acceptedSuggestions?: Array<{ id?: string }>;
  overrideReason?: {
    reason?: { code?: string; system?: string; display?: string };
    userComment?: string;
  };
  outcomeTimestamp?: string;
}

export interface CdsFeedbackRequest {
  feedback?: CdsFeedbackEntry[];
}
