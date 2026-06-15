/**
 * MAT-compatible FHIR R4 export (#108) — TS port of MeasureExportService.exportAsMatBundle. JVM-free.
 *
 * Builds a FHIR R4 `Bundle` (type=collection) carrying a `Library` (the CQL logic library, CQL
 * attached as base64 `text/cql`) and a `Measure` (referencing the library by `urn:uuid:`), plus a
 * `ValueSet` per attached value set. Java used HAPI to assemble + serialize + validate; we have no
 * FHIR runtime (no new dep), so we hand-build well-formed FHIR R4 XML by construction — elements in
 * canonical R4 order, attribute values escaped, the nested resources inheriting the Bundle's default
 * namespace (HAPI's on-the-wire shape).
 *
 * Fidelity note: value-set *linkage* is not ported yet (value-set governance is a later batch and the
 * TS MeasureRecord carries no attached value sets), so today's bundle is Library + Measure. The
 * ValueSet path is wired and unit-covered so it lights up unchanged once governance lands.
 */
import type { MeasureRecord } from "../stores/measure-store.ts";

/** One value set to embed (shape the governance batch will supply). */
export interface ExportValueSet {
  id: string;
  oid: string | null;
  name: string;
  version: string | null;
  canonicalUrl: string | null;
  codes: Array<{ system?: string; code?: string; display?: string }>;
}

type PublicationStatus = "active" | "retired" | "draft";

function resolvePublicationStatus(status: string): PublicationStatus {
  switch ((status ?? "").trim().toUpperCase()) {
    case "ACTIVE":
    case "APPROVED":
      return "active";
    case "DEPRECATED":
      return "retired";
    default:
      return "draft";
  }
}

/** Strip to an XML/FHIR-safe identifier (MeasureExportService.safeIdentifier). */
function safeIdentifier(value: string | null | undefined): string {
  if (!value || value.trim() === "") return "WorkWellMeasure";
  const normalized = value.replace(/[^A-Za-z0-9]+/g, "");
  return normalized === "" ? "WorkWellMeasure" : normalized;
}

function resolveMeasureDescription(description: string | undefined, policyRef: string | null): string {
  if (description && description.trim() !== "") return description;
  if (policyRef && policyRef.trim() !== "") return `Policy reference: ${policyRef}`;
  return "Exported from WorkWell Measure Studio";
}

function resolveValueSetUrl(vs: ExportValueSet): string {
  if (vs.canonicalUrl && vs.canonicalUrl.trim() !== "") return vs.canonicalUrl;
  if (vs.oid && vs.oid.trim() !== "") return `urn:oid:${vs.oid}`;
  return `urn:uuid:${vs.id}`;
}

/** Escape a string for use inside an XML double-quoted attribute value. */
function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function base64Utf8(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}

/** A minimal FHIR-XML element emitter: indentation + `<name value="..."/>` primitives + nesting. */
class Xml {
  private readonly lines: string[] = [];
  constructor(private indent = 0) {}

  /** A primitive element `<name value="escaped"/>`. */
  value(name: string, value: string): void {
    this.lines.push(`${this.pad()}<${name} value="${escAttr(value)}"/>`);
  }

  /** An open/close wrapper around `body` (called with a child emitter one level deeper). */
  block(name: string, attrs: string, body: (x: Xml) => void): void {
    this.lines.push(`${this.pad()}<${name}${attrs ? " " + attrs : ""}>`);
    const child = new Xml(this.indent + 1);
    body(child);
    this.lines.push(child.render());
    this.lines.push(`${this.pad()}</${name}>`);
  }

  render(): string {
    return this.lines.join("\n");
  }

  private pad(): string {
    return "  ".repeat(this.indent);
  }
}

function libraryElement(x: Xml, record: MeasureRecord, libraryId: string): void {
  // Canonical R4 Library order: id, version, name, title, status, type, content.
  x.block("Library", "", (lib) => {
    lib.value("id", libraryId);
    lib.value("version", record.version);
    lib.value("name", `${safeIdentifier(record.name)}CQL`);
    lib.value("title", `${record.name} CQL Library`);
    lib.value("status", resolvePublicationStatus(record.status));
    lib.block("type", "", (t) =>
      t.block("coding", "", (c) => {
        c.value("system", "http://terminology.hl7.org/CodeSystem/library-type");
        c.value("code", "logic-library");
        c.value("display", "Logic Library");
      }),
    );
    if (record.cqlText && record.cqlText.trim() !== "") {
      lib.block("content", "", (ct) => {
        ct.value("contentType", "text/cql");
        ct.value("data", base64Utf8(record.cqlText));
      });
    }
  });
}

function measureElement(x: Xml, record: MeasureRecord, measureId: string, libraryId: string): void {
  // Canonical R4 Measure order: id, version, name, title, status, publisher, description, library.
  x.block("Measure", "", (m) => {
    m.value("id", measureId);
    m.value("version", record.version);
    m.value("name", safeIdentifier(record.name));
    m.value("title", record.name);
    m.value("status", resolvePublicationStatus(record.status));
    m.value("publisher", "WorkWell Measure Studio");
    m.value("description", resolveMeasureDescription(record.spec?.description, record.policyRef));
    m.value("library", `urn:uuid:${libraryId}`);
  });
}

/** Group a value set's codes by code system (blank system → urn:workwell:local), preserving order. */
function groupCodesBySystem(codes: ExportValueSet["codes"]): Map<string, ExportValueSet["codes"]> {
  const grouped = new Map<string, ExportValueSet["codes"]>();
  for (const row of codes) {
    const system = row.system && row.system.trim() !== "" ? row.system : "urn:workwell:local";
    if (!grouped.has(system)) grouped.set(system, []);
    grouped.get(system)!.push(row);
  }
  return grouped;
}

function valueSetElement(x: Xml, vs: ExportValueSet, resourceId: string): void {
  // Canonical R4 ValueSet order: id, url, version, name, title, status, compose.
  x.block("ValueSet", "", (v) => {
    v.value("id", resourceId);
    v.value("url", resolveValueSetUrl(vs));
    const version = (vs.version ?? "").trim();
    if (version !== "") v.value("version", version);
    v.value("name", safeIdentifier(vs.name));
    v.value("title", vs.name);
    v.value("status", "active");

    const bySystem = groupCodesBySystem(vs.codes);
    const includes = [...bySystem.entries()].filter(([, rows]) => rows.some((r) => (r.code ?? "").trim() !== ""));
    if (includes.length > 0) {
      v.block("compose", "", (compose) => {
        for (const [system, rows] of includes) {
          compose.block("include", "", (inc) => {
            inc.value("system", system);
            for (const row of rows) {
              const code = (row.code ?? "").trim();
              if (code === "") continue;
              inc.block("concept", "", (concept) => {
                concept.value("code", code);
                const display = (row.display ?? "").trim();
                if (display !== "") concept.value("display", display);
              });
            }
          });
        }
      });
    }
  });
}

/**
 * Build the MAT FHIR R4 Bundle XML for a measure version. `valueSets` defaults to none until the
 * value-set governance batch supplies the attached sets.
 */
export function exportMatBundle(record: MeasureRecord, valueSets: ExportValueSet[] = []): string {
  const bundleId = crypto.randomUUID();
  const libraryId = crypto.randomUUID();
  const measureResourceId = crypto.randomUUID();

  const root = new Xml(0);
  root.block("Bundle", 'xmlns="http://hl7.org/fhir"', (bundle) => {
    bundle.value("id", bundleId);
    bundle.value("type", "collection");

    const entry = (resourceId: string, body: (x: Xml) => void) => {
      bundle.block("entry", "", (e) => {
        e.value("fullUrl", `urn:uuid:${resourceId}`);
        e.block("resource", "", body);
      });
    };

    entry(libraryId, (e) => libraryElement(e, record, libraryId));
    entry(measureResourceId, (e) => measureElement(e, record, measureResourceId, libraryId));
    for (const vs of valueSets) {
      const vsResourceId = crypto.randomUUID();
      entry(vsResourceId, (e) => valueSetElement(e, vs, vsResourceId));
    }
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n${root.render()}\n`;
}
