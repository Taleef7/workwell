/**
 * server.ts — the shim's HTTP layer (plain node:http; no framework, ADR-034).
 *
 * Serves the verified WebChart client contract under `/fhir` (see
 * `backend-ts/src/engine/ingress/webchart/webchart-client.ts`):
 *   GET /fhir/metadata                          → CapabilityStatement (availability probe)
 *   GET /fhir/Patient?_count=&_offset=          → paged searchset; SAME-ORIGIN link[next]
 *   GET /fhir/{Observation|Procedure}?patient=  → per-patient searchsets (PR-3)
 *   GET /fhir/{Condition|Immunization|Encounter}?patient= → valid empty searchsets
 *
 * `Authorization` is accepted but never enforced — Doug's "you don't even need security"
 * dev/demo posture; the header path of the static-bearer seam still gets exercised.
 * The `link[next]` URL is minted from the INCOMING Host header so it is same-origin by
 * construction (the client hard-fails on off-origin pagination).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ShimDb } from "./db.ts";
import {
  capabilityStatement,
  observationToFhir,
  patIdFromSubjectId,
  patientToFhir,
  procedureToFhir,
  searchsetBundle,
} from "./fhir-mapping.ts";

const DEFAULT_COUNT = 100;
const MAX_COUNT = 500;

export interface ShimDeps {
  db: ShimDb;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/fhir+json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function operationOutcome(severity: "error" | "warning", code: string, diagnostics: string): unknown {
  return { resourceType: "OperationOutcome", issue: [{ severity, code, diagnostics }] };
}

function parseCount(url: URL): number {
  const raw = url.searchParams.get("_count");
  const n = raw ? Number(raw) : DEFAULT_COUNT;
  if (!Number.isInteger(n) || n < 1) return DEFAULT_COUNT;
  return Math.min(n, MAX_COUNT);
}

function parseOffset(url: URL): number {
  const raw = url.searchParams.get("_offset");
  const n = raw ? Number(raw) : 0;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Absolute same-origin URL for the next page, minted from the request's own Host header. */
function nextPageUrl(req: IncomingMessage, url: URL, count: number, nextOffset: number): string {
  const host = req.headers.host ?? "localhost";
  const next = new URL(url.pathname, `http://${host}`);
  for (const [k, v] of url.searchParams) if (k !== "_offset") next.searchParams.set(k, v);
  next.searchParams.set("_count", String(count));
  next.searchParams.set("_offset", String(nextOffset));
  return next.toString();
}

async function handlePatientSearch(deps: ShimDeps, req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
  const count = parseCount(url);
  const offset = parseOffset(url);
  const [total, rows] = await Promise.all([deps.db.countPatients(), deps.db.listPatients(count, offset)]);
  const nextOffset = offset + rows.length;
  const nextUrl = rows.length === count && nextOffset < total ? nextPageUrl(req, url, count, nextOffset) : undefined;
  sendJson(res, 200, searchsetBundle(rows.map(patientToFhir), { total, nextUrl }));
}

async function handleClinicalSearch(
  deps: ShimDeps,
  type: "Observation" | "Condition" | "Procedure" | "Immunization" | "Encounter",
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const patientParam = url.searchParams.get("patient");
  if (!patientParam) {
    sendJson(res, 400, operationOutcome("error", "required", `${type} search requires a 'patient' parameter`));
    return;
  }
  const patId = patIdFromSubjectId(patientParam.replace(/^Patient\//, ""));
  if (patId === undefined) {
    // Unknown id shape ⇒ nothing matches; a valid empty searchset (not an error) mirrors FHIR search semantics.
    sendJson(res, 200, searchsetBundle([]));
    return;
  }
  if (type === "Observation") {
    const rows = await deps.db.observationsForPatient(patId);
    sendJson(res, 200, searchsetBundle(rows.map((row, i) => observationToFhir(row, i + 1))));
    return;
  }
  if (type === "Procedure") {
    const rows = await deps.db.proceduresForPatient(patId);
    sendJson(res, 200, searchsetBundle(rows.map((row, i) => procedureToFhir(row, i + 1))));
    return;
  }
  // WCDB has no coded Condition/Immunization/Encounter source tables in the dev seed — the client
  // still queries all five types, so these return valid EMPTY searchsets (never 404s).
  sendJson(res, 200, searchsetBundle([]));
}

const CLINICAL_TYPES = new Set(["Observation", "Condition", "Procedure", "Immunization", "Encounter"] as const);
type ClinicalType = "Observation" | "Condition" | "Procedure" | "Immunization" | "Encounter";

export function createShimServer(deps: ShimDeps): Server {
  return createServer((req, res) => {
    void route(deps, req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, operationOutcome("error", "exception", message));
      else res.end();
    });
  });
}

async function route(deps: ShimDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method !== "GET") {
    sendJson(res, 405, operationOutcome("error", "not-supported", `${req.method} is not supported`));
    return;
  }

  const fhirMatch = /^\/fhir\/([A-Za-z]+)$/.exec(url.pathname);
  if (url.pathname === "/fhir/metadata" || (fhirMatch && fhirMatch[1] === "metadata")) {
    sendJson(res, 200, capabilityStatement());
    return;
  }
  if (fhirMatch && fhirMatch[1] === "Patient") {
    await handlePatientSearch(deps, req, url, res);
    return;
  }
  if (fhirMatch && CLINICAL_TYPES.has(fhirMatch[1] as ClinicalType)) {
    await handleClinicalSearch(deps, fhirMatch[1] as ClinicalType, url, res);
    return;
  }
  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 404, operationOutcome("error", "not-found", `no route for ${url.pathname}`));
}
