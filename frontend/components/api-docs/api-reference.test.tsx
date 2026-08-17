import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiReference } from "./api-reference";
import { endpointsOf, typeLabel, type OpenApiDoc } from "./types";

/**
 * The renderer for the OpenAPI reference page (ADR-068).
 *
 * The assertion that matters is that **no operation is silently dropped**. A reference page that renders
 * five of six operations looks finished and is wrong in the one way a reader cannot detect — the same defect
 * class as a documented-but-unrouted path, one layer up.
 */
const doc: OpenApiDoc = {
  openapi: "3.1.1",
  info: { title: "WorkWell", version: "1.0.0" },
  tags: [{ name: "compliance", description: "Answers." }],
  paths: {
    "/api/v1/compliance/{subjectId}/{measureId}": {
      get: {
        operationId: "getCompliance",
        summary: "Is this subject compliant?",
        tags: ["compliance"],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "subjectId", in: "path", required: true, description: "The subject id.", schema: { type: "string", example: "emp-006" } },
          { name: "mode", in: "query", schema: { type: "string", enum: ["latest", "preview"] } },
        ],
        responses: {
          "200": { description: "The answer.", content: { "application/json": { schema: { $ref: "#/components/schemas/Answer" } } } },
          "404": { description: "No finalized outcome." },
        },
      },
    },
    "/cds-services": {
      // No tag at all — this operation must still appear.
      get: { operationId: "cdsDiscovery", summary: "Discover services", security: [], responses: { "200": { description: "Catalog." } } },
    },
  },
  components: {
    schemas: {
      Answer: {
        type: "object",
        required: ["status", "period"],
        properties: {
          status: { type: "string", description: "THE ANSWER.", enum: ["COMPLIANT", "OVERDUE"] },
          period: { type: "object", properties: { start: { type: ["string", "null"], description: "ISO-8601 or null." } } },
        },
      },
    },
  },
};

describe("ApiReference", () => {
  it("renders every operation in the document, including untagged ones", () => {
    render(<ApiReference doc={doc} origin="https://api.example.org" />);
    // Two operations exist; both must be on the page.
    expect(endpointsOf(doc)).toHaveLength(2);
    expect(screen.getByText("Is this subject compliant?")).toBeInTheDocument();
    expect(screen.getByText("Discover services")).toBeInTheDocument();
    // The untagged one lands under "Other" rather than vanishing.
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.getByText("compliance")).toBeInTheDocument();
  });

  it("shows the method, path, auth posture, parameters and status codes", () => {
    render(<ApiReference doc={doc} origin="https://api.example.org" />);
    expect(screen.getByText("/api/v1/compliance/{subjectId}/{measureId}")).toBeInTheDocument();
    expect(screen.getAllByText("GET").length).toBe(2);
    // A bearer-gated operation and a public one must be distinguishable at a glance.
    expect(screen.getByText("bearer token")).toBeInTheDocument();
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByText("subjectId")).toBeInTheDocument();
    expect(screen.getByText("latest | preview")).toBeInTheDocument();
    expect(screen.getByText("No finalized outcome.")).toBeInTheDocument();
  });

  it("follows a $ref into components and renders the 3.1 nullable union honestly", () => {
    render(<ApiReference doc={doc} origin="https://api.example.org" />);
    expect(screen.getByText("THE ANSWER.")).toBeInTheDocument();
    // `["string","null"]` must read as a union, not as "string" — the field really can be null.
    expect(screen.getByText("string | null")).toBeInTheDocument();
  });

  it("builds a curl example that substitutes path parameters and includes the token header", () => {
    render(<ApiReference doc={doc} origin="https://api.example.org" />);
    // Scoped to the compliance operation: both operations render a curl block against the same origin.
    const curl = screen.getByText(/^curl -sS https:\/\/api\.example\.org\/api\/v1\/compliance/);
    expect(curl.textContent).toContain("/api/v1/compliance/emp-006/");
    expect(curl.textContent).toContain("authorization: Bearer <token>");
    expect(screen.getByLabelText("Copy curl for getCompliance")).toBeInTheDocument();
  });

  it("renders an honest empty state for a document with no operations", () => {
    render(<ApiReference doc={{ openapi: "3.1.1", paths: {} }} origin="https://api.example.org" />);
    expect(screen.getByText("This OpenAPI document describes no operations.")).toBeInTheDocument();
  });
});

describe("typeLabel", () => {
  it("names a $ref, a union and a formatted primitive", () => {
    expect(typeLabel({ $ref: "#/components/schemas/Answer" })).toBe("Answer");
    expect(typeLabel({ type: ["string", "null"] })).toBe("string | null");
    expect(typeLabel({ type: "string", format: "date" })).toBe("string (date)");
    expect(typeLabel({ enum: ["a"] })).toBe("enum");
    expect(typeLabel(undefined)).toBe("");
  });
});
