/**
 * The WorkWell OpenAPI document (ADR-068) — hand-authored, zero dependencies.
 *
 * ## Scope: the PROMISED surface only
 *
 * `/api/v1/**` and the standards surfaces, plus health and version. The ~40 internal `/api/**` routes are
 * deliberately absent: `docs/COMPLIANCE_API.md` draws that line already ("everything else under `/api/` is
 * internal and moves with the frontend"), and documenting them here would advertise stability over paths
 * that carry none. A small document that stays true beats a large one that starts drifting the day it lands
 * — which is not a hypothetical, since `ARCHITECTURE.md` claimed a springdoc OpenAPI document for a year
 * after the JVM was retired.
 *
 * ## Why 3.1.1 and not 3.2
 *
 * 3.2.0 exists (Sept 2025) and buys these seven operations nothing. Renderer support is worse than absent,
 * it is *silent*: Redoc 2.5.3 accepts a 3.2 document by aliasing it to 3.1, so 3.2-only constructs are
 * ignored rather than flagged, and Spectral caps at 3.1. 3.1's Schema Objects are literal JSON Schema
 * 2020-12, which is also what makes the zero-dependency response check in `openapi.test.ts` tractable.
 *
 * ## Why hand-authored
 *
 * The alternatives all cost a dependency or a rewrite: zod is only worth it as a *runtime* validator (a new
 * runtime dep), `@hono/zod-openapi` presupposes Hono and a router we do not have, and TypeSpec would add a
 * second hand-maintained source of truth with no coupling to a hand-rolled dispatcher. The recognised risk
 * of hand-authoring is drift, and the recognised answer is a contract test — which is why the guard in
 * `openapi.test.ts` is not optional garnish here but the other half of the decision.
 *
 * ## CDS Hooks is DESCRIBED, not redefined
 *
 * The only published OpenAPI description of CDS Hooks is `cds-hooks/api` — Swagger 2.0, CDS Hooks 1.0, last
 * pushed January 2021 — so there is nothing current to `$ref`. These operations describe OUR conformance to
 * the shapes in https://cds-hooks.hl7.org/2.0/, and the spec text says exactly that.
 *
 * ## The five Redocly warnings are expected, and neither is silenced
 *
 * `redocly lint` reports 0 errors and 5 warnings, and no ignore file is used, because an ignore file hides a
 * finding rather than answering it. One is `info-license` (see below). The other four are
 * `operation-4xx-response` on the four unauthenticated GETs that genuinely have no 4xx: health, version,
 * discovery and this document all answer 200 or nothing. Their non-GET behaviour is a **405 on the path**,
 * which OpenAPI models per-operation and therefore cannot express under a `get` — declaring it there would
 * make the document say the GET returns 405, which is false, and the two-way coverage test in
 * `openapi.test.ts` catches exactly that (it did, on the first attempt).
 */

export interface OpenApiSchema {
  /** A union such as `["string", "null"]` is how OpenAPI 3.1 spells nullability — 3.0's `nullable` was removed. */
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  additionalProperties?: boolean | OpenApiSchema;
  $ref?: string;
  example?: unknown;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, { schema: OpenApiSchema }>;
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query";
  required?: boolean;
  description?: string;
  schema: OpenApiSchema;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: OpenApiParameter[];
  requestBody?: { required: boolean; content: Record<string, { schema: OpenApiSchema }> };
  responses: Record<string, OpenApiResponse>;
}

export interface OpenApiDocument {
  openapi: string;
  info: Record<string, unknown>;
  servers: Array<{ url: string; description?: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, Record<string, unknown>>;
    schemas: Record<string, OpenApiSchema>;
  };
}

const BEARER = [{ bearerAuth: [] as string[] }];

const str = (description: string, example?: unknown): OpenApiSchema => ({ type: "string", description, ...(example !== undefined ? { example } : {}) });
const bool = (description: string): OpenApiSchema => ({ type: "boolean", description });
const jsonBody = (ref: string): Record<string, { schema: OpenApiSchema }> => ({
  "application/json": { schema: { $ref: `#/components/schemas/${ref}` } },
});

const errorResponse = (description: string): OpenApiResponse => ({ description, content: jsonBody("Error") });

export function openApiDocument(): OpenApiDocument {
  return {
    openapi: "3.1.1",
    info: {
      title: "WorkWell Measure Studio — integration API",
      version: "1.0.0",
      summary: "Given a patient and a measure, are they compliant?",
      description: [
        "The versioned contract an integrator builds against, plus the CDS Hooks service.",
        "",
        "**Scope.** This document covers `/api/v1/**`, the CDS Hooks surface, and health/version. The rest of",
        "`/api/**` is an internal contract that moves with the frontend and carries no stability promise, so it",
        "is deliberately not described here.",
        "",
        "**Stability.** A field present in this document will not be removed or change type, and a breaking",
        "change means `/api/v2/`. New fields may appear — parse permissively and ignore what you do not",
        "recognise.",
        "",
        "**CDS Hooks.** The `/cds-services` operations describe WorkWell's conformance to the shapes defined by",
        "CDS Hooks 2.0.1 (https://cds-hooks.hl7.org/2.0/); they do not redefine that specification. Note that",
        "authentication here is WorkWell's own bearer token, NOT the CDS Hooks signed-JWT profile, which",
        "forbids symmetric algorithms and is a documented gap.",
        "",
        "**Compliance is computed by CQL and only by CQL.** No response in this document is produced by an AI",
        "surface.",
      ].join("\n"),
      // No `license` block. Redocly warns either way — `info-license` when it is absent, and
      // `info-license-strict` when it is present without a URL or SPDX identifier — and this repo publishes
      // no licence for the application, so asserting one would be the worse of two equal warnings.
    },
    servers: [{ url: "/", description: "This deployment" }],
    tags: [
      { name: "compliance", description: "Per-subject, per-measure compliance answers." },
      { name: "cds-hooks", description: "CDS Hooks 2.0.1 service — decision support cards for a patient." },
      { name: "meta", description: "Discovery and health." },
    ],
    paths: {
      "/api/v1/compliance/{subjectId}/{measureId}": {
        get: {
          operationId: "getCompliance",
          summary: "Is this subject compliant with this measure?",
          description: [
            "`mode=latest` (default) reads the most recent outcome from a FINALIZED run. `mode=preview`",
            "evaluates now and persists nothing, is restricted to `ROLE_CASE_MANAGER`/`ROLE_ADMIN` because it",
            "costs an evaluation, and returns **501** on a WebChart-configured deployment where it would",
            "otherwise evaluate a synthetic bundle and report it as an evaluation of real data.",
            "",
            "Read `populationsSource` before trusting `populations`: `status-derived` means only the initial",
            "population is measured and the rest are inferred from `status`.",
          ].join("\n"),
          tags: ["compliance"],
          security: BEARER,
          parameters: [
            {
              name: "subjectId",
              in: "path",
              required: true,
              description: "The employee/patient external id. Percent-encode it — WebChart ids contain `|`.",
              schema: str("Subject external id", "emp-006"),
            },
            {
              name: "measureId",
              in: "path",
              required: true,
              description: "A WorkWell catalog id. An unknown id is a 400 that lists the known ids.",
              schema: str("Measure id", "cms125"),
            },
            { name: "start", in: "query", description: "Inclusive lower bound on the evaluation period.", schema: { type: "string", format: "date" } },
            { name: "end", in: "query", description: "Inclusive upper bound on the evaluation period.", schema: { type: "string", format: "date" } },
            { name: "mode", in: "query", description: "`latest` (default) or `preview`.", schema: { type: "string", enum: ["latest", "preview"] } },
          ],
          responses: {
            "200": { description: "The compliance answer.", content: jsonBody("ComplianceAnswer") },
            "400": errorResponse("Malformed request: unknown measure, bad date, bad percent-encoding, or `start` with `mode=preview`."),
            "401": errorResponse("No bearer token."),
            "403": errorResponse("`mode=preview` requires ROLE_CASE_MANAGER or ROLE_ADMIN."),
            "404": errorResponse("No FINALIZED outcome covers this subject and measure. This is the absence of a run, NOT a statement of compliance."),
            "501": errorResponse("`mode=preview` is unavailable on a WebChart-configured deployment."),
          },
        },
      },
      "/cds-services": {
        get: {
          operationId: "cdsDiscovery",
          summary: "Discover the CDS Hooks services this deployment offers",
          description: "Public — service metadata only, no patient data. No `prefetch` is declared, because none is evaluated.",
          tags: ["cds-hooks"],
          security: [],
          responses: {
            "200": { description: "The service catalog.", content: jsonBody("CdsDiscoveryResponse") },
          },
        },
      },
      "/cds-services/{serviceId}": {
        post: {
          operationId: "cdsInvoke",
          summary: "Invoke a CDS Hooks service and receive cards",
          description: [
            "Cards render the most recent FINALIZED WorkWell evaluation. `prefetch`, `fhirServer` and",
            "`fhirAuthorization` are accepted and **not** evaluated.",
            "",
            "A patient with no completed evaluation receives one informational card saying so — never an empty",
            "card list, which at the point of care would read as \"no gaps\". An empty list means the patient",
            "*was* evaluated and has none.",
          ].join("\n"),
          tags: ["cds-hooks"],
          security: BEARER,
          parameters: [{ name: "serviceId", in: "path", required: true, description: "A service `id` from discovery.", schema: str("Service id", "workwell-compliance-patient-view") }],
          requestBody: { required: true, content: jsonBody("CdsRequest") },
          responses: {
            "200": { description: "Cards (possibly empty).", content: jsonBody("CdsResponse") },
            "400": errorResponse("Missing `hook`/`hookInstance`/`context.patientId`, a hook this service does not serve, or a body that is not JSON."),
            "401": errorResponse("No bearer token."),
            "403": errorResponse("The authenticated role may not invoke a CDS service."),
            "404": errorResponse("Unknown service id."),
          },
        },
      },
      "/cds-services/{serviceId}/feedback": {
        post: {
          operationId: "cdsFeedback",
          summary: "Report that a card was accepted or overridden",
          description: "Audited. `acceptedSuggestions` is required when `outcome` is `accepted`.",
          tags: ["cds-hooks"],
          security: BEARER,
          parameters: [{ name: "serviceId", in: "path", required: true, description: "A service `id` from discovery.", schema: str("Service id", "workwell-compliance-patient-view") }],
          requestBody: { required: true, content: jsonBody("CdsFeedbackRequest") },
          responses: {
            "200": { description: "Recorded. No response body." },
            "400": errorResponse("Empty feedback array, an outcome other than `accepted`/`overridden`, or `accepted` without `acceptedSuggestions`."),
            "401": errorResponse("No bearer token."),
            "403": errorResponse("The authenticated role may not submit feedback."),
            "404": errorResponse("Unknown service id."),
          },
        },
      },
      "/api/v1/openapi.json": {
        get: {
          operationId: "getOpenApiDocument",
          summary: "This document",
          tags: ["meta"],
          security: [],
          responses: {
            "200": { description: "The OpenAPI 3.1 document.", content: { "application/json": { schema: { type: "object", description: "An OpenAPI 3.1 document." } } } },
          },
        },
      },
      "/actuator/health": {
        get: {
          operationId: "getHealth",
          summary: "Liveness",
          description: "Deliberately DB-free: a 200 here is not evidence that the database is reachable.",
          tags: ["meta"],
          security: [],
          responses: { "200": { description: "The worker is serving.", content: jsonBody("Health") } },
        },
      },
      "/api/version": {
        get: {
          operationId: "getVersion",
          summary: "API version and build",
          tags: ["meta"],
          security: [],
          responses: { "200": { description: "Version discovery.", content: jsonBody("Version") } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "An access token from `POST /api/auth/login`. Refresh tokens are rejected.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          description: "Every non-2xx response in this document.",
          required: ["error"],
          properties: {
            error: str("A stable machine-readable code, e.g. `no_outcome`.", "no_outcome"),
            message: str("Human-readable detail. Not stable; do not parse."),
          },
        },
        ComplianceAnswer: {
          type: "object",
          required: ["subject", "measure", "period", "filter", "status", "populations", "populationsSource", "provenance"],
          properties: {
            subject: { type: "object", required: ["id"], properties: { id: str("The subject external id.", "emp-006") } },
            measure: {
              type: "object",
              required: ["id", "name"],
              properties: {
                id: str("WorkWell catalog id.", "cms125"),
                name: str("Display name."),
                ecqmId: str("Present only when an official CMS artifact produced this outcome.", "CMS125FHIR"),
                version: str("The official artifact version, when applicable.", "1.0.000"),
              },
            },
            period: {
              type: "object",
              description: "The measurement window the ANSWER covers — not an echo of the request.",
              required: ["start", "end"],
              properties: { start: { type: ["string", "null"], description: "ISO-8601, or null when genuinely unknown." }, end: { type: ["string", "null"], description: "ISO-8601, or null when genuinely unknown." } },
            },
            filter: {
              type: "object",
              description: "The bounds YOU sent, echoed back so the two can never be read as each other.",
              required: ["start", "end"],
              properties: { start: { type: ["string", "null"] }, end: { type: ["string", "null"] } },
            },
            status: {
              type: "string",
              description: "THE ANSWER.",
              enum: ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"],
            },
            populations: {
              type: "object",
              required: ["initialPopulation", "denominator", "denominatorExclusion", "denominatorException", "numerator"],
              properties: {
                initialPopulation: bool("In the measure's initial population."),
                denominator: bool("In the denominator."),
                denominatorExclusion: bool("Excluded from the denominator."),
                denominatorException: bool("A denominator exception."),
                numerator: bool("In the numerator."),
              },
            },
            populationsSource: {
              type: "string",
              description: "`official-evidence` = the executor's own measured vector. `status-derived` = only the initial population is real; the rest are inferred from `status`. Read this before trusting `populations`.",
              enum: ["official-evidence", "status-derived"],
            },
            provenance: {
              type: "object",
              description: "Diagnostic. Its contents may grow.",
              additionalProperties: true,
              properties: {
                mode: { type: "string", enum: ["latest", "preview"] },
                runId: { type: ["string", "null"], description: "Null for `mode=preview`, because there is no run." },
                evaluatedAt: str("ISO-8601."),
              },
            },
          },
        },
        CdsService: {
          type: "object",
          required: ["hook", "id", "title", "description", "usageRequirements"],
          properties: {
            hook: str("The hook this service is invoked on.", "patient-view"),
            id: str("The `{serviceId}` in the invoke path.", "workwell-compliance-patient-view"),
            title: str("Human-readable name."),
            description: str("What the service returns."),
            usageRequirements: str("What a caller must know — including what this service does NOT do."),
          },
        },
        CdsDiscoveryResponse: {
          type: "object",
          required: ["services"],
          properties: { services: { type: "array", items: { $ref: "#/components/schemas/CdsService" } } },
        },
        CdsRequest: {
          type: "object",
          required: ["hook", "hookInstance", "context"],
          properties: {
            hook: str("Must match the service's declared hook.", "patient-view"),
            hookInstance: str("A UUID identifying this invocation."),
            fhirServer: { type: "string", description: "Accepted and NOT evaluated." },
            fhirAuthorization: { type: "object", description: "Accepted and NOT evaluated.", additionalProperties: true },
            prefetch: { type: "object", description: "Accepted and NOT evaluated. No prefetch template is declared.", additionalProperties: true },
            context: {
              type: "object",
              required: ["patientId"],
              properties: {
                patientId: str("The FHIR `Patient.id`. A bare WebChart id is also tried as `wc|<id>`.", "emp-006"),
                userId: str("`Practitioner/abc` or `PractitionerRole/123`."),
                encounterId: str("The current encounter, when the client has one."),
              },
            },
          },
        },
        CdsCard: {
          type: "object",
          required: ["summary", "indicator", "source"],
          properties: {
            summary: str("At most 140 characters, per the CDS Hooks specification."),
            indicator: {
              type: "string",
              description: "`critical` is never emitted: it means the user must not proceed, and WorkWell is supplementary to WebChart.",
              enum: ["info", "warning"],
            },
            source: {
              type: "object",
              required: ["label"],
              properties: { label: str("Always `WorkWell Measure Studio`."), url: str("A link to the measure, when a Studio origin is configured.") },
            },
            detail: str("Markdown. Names the run and states that the answer was computed by CQL."),
            uuid: str("Derived from (runId, subjectId, measureId) — stable across re-invocations of the same run. Cite it when posting feedback."),
            links: { type: "array", items: { type: "object", required: ["label", "url", "type"], properties: { label: str("Link text."), url: str("Absolute URL."), type: { type: "string", enum: ["absolute"] } } } },
            suggestions: {
              type: "array",
              description: "Present only where the proposed order code carries an APPROVED terminology mapping.",
              items: {
                type: "object",
                required: ["label", "uuid", "actions"],
                properties: {
                  label: str("Button text."),
                  uuid: str("Cite this in `acceptedSuggestions`."),
                  actions: { type: "array", items: { type: "object", required: ["type", "description", "resource"], properties: { type: { type: "string", enum: ["create"] }, description: str("What accepting would do."), resource: { type: "object", description: "A FHIR R4 ServiceRequest with `intent=proposal`, `status=draft`. Advisory — a clinician submits.", additionalProperties: true } } } },
                },
              },
            },
            selectionBehavior: { type: "string", description: "Present whenever `suggestions` is.", enum: ["at-most-one"] },
          },
        },
        CdsResponse: {
          type: "object",
          required: ["cards"],
          properties: {
            cards: {
              type: "array",
              description: "Empty ONLY when the patient was evaluated and has no open gap. An unevaluated patient gets one informational card instead.",
              items: { $ref: "#/components/schemas/CdsCard" },
            },
          },
        },
        CdsFeedbackRequest: {
          type: "object",
          required: ["feedback"],
          properties: {
            feedback: {
              type: "array",
              items: {
                type: "object",
                required: ["card", "outcome", "outcomeTimestamp"],
                properties: {
                  card: str("The `card.uuid` from the invoke response."),
                  outcome: { type: "string", enum: ["accepted", "overridden"] },
                  acceptedSuggestions: { type: "array", description: "Required when `outcome` is `accepted`.", items: { type: "object", properties: { id: str("The `suggestion.uuid`.") } } },
                  overrideReason: { type: "object", additionalProperties: true, description: "A Coding plus an optional free-text comment." },
                  outcomeTimestamp: str("ISO-8601 UTC."),
                },
              },
            },
          },
        },
        Health: {
          type: "object",
          required: ["status", "stack"],
          properties: { status: { type: "string", enum: ["UP"] }, stack: str("Implementation identifier.", "workwell-ts") },
        },
        Version: {
          type: "object",
          required: ["api", "stack", "build"],
          properties: { api: str("The API contract version.", "v1"), stack: str("Implementation.", "typescript"), build: str("Build identifier.", "workwell-api-ts") },
        },
      },
    },
  };
}
