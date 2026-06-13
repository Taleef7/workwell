/**
 * Runtime CQL → ELM translator (issue #96) — the SAME pure-Node `@cqframework/cql`
 * (Kotlin-Multiplatform, NO JVM) used at build time in scripts/compile-measures.mjs,
 * here exposed for live compilation so the ELM Explorer can recompile as you edit CQL.
 *
 * This proves the translator runs JVM-free at runtime too, not only at build time —
 * exactly what the de-Java re-platform (ADR-008, Path C) is about. Read/compute only;
 * it never persists anything and never decides compliance.
 *
 * Resources (System + FHIR R4 model-info XML and the FHIRHelpers CQL — version-stable
 * standard config) are bundled as a static JSON import (cql-resources.json, generated
 * by scripts/compile-measures.mjs), NOT read from disk at runtime. This mirrors
 * elm/index.ts and keeps the module portable across every @mieweb/cloud target,
 * including Cloudflare Workers where node:fs is unavailable by default.
 */
import {
  ModelManager,
  LibraryManager,
  CqlTranslator,
  createModelInfoProvider,
  createLibrarySourceProvider,
  stringAsSource,
  // @ts-expect-error — @cqframework/cql ships its own bundled types via subpath
} from "@cqframework/cql/cql-to-elm";
import resources from "./resources/cql-resources.json" with { type: "json" };

const { systemModelInfoXml, fhirModelInfoXml, fhirHelpersCql } = resources as {
  systemModelInfoXml: string;
  fhirModelInfoXml: string;
  fhirHelpersCql: string;
};

function manager(): unknown {
  const mm = new ModelManager();
  mm.modelInfoLoader.registerModelInfoProvider(
    createModelInfoProvider((name: string) =>
      name === "System" ? stringAsSource(systemModelInfoXml) : name === "FHIR" ? stringAsSource(fhirModelInfoXml) : null,
    ),
  );
  const lm = new LibraryManager(mm);
  lm.librarySourceLoader.registerProvider(
    createLibrarySourceProvider((name: string) => (name === "FHIRHelpers" ? stringAsSource(fhirHelpersCql) : null)),
  );
  return lm;
}

export interface CqlDiagnostic {
  severity: string;
  message: string;
  startLine?: number;
  startChar?: number;
  endLine?: number;
  endChar?: number;
}

export interface CompileResult {
  ok: boolean;
  elm: unknown;
  diagnostics: CqlDiagnostic[];
}

/** Pull CqlToElmError annotations off the compiled ELM into a flat diagnostics list. */
function extractDiagnostics(elm: { library?: { annotation?: unknown[] } }): CqlDiagnostic[] {
  const out: CqlDiagnostic[] = [];
  for (const ann of elm.library?.annotation ?? []) {
    const a = ann as Record<string, unknown>;
    if (a.type === "CqlToElmError") {
      out.push({
        severity: typeof a.errorSeverity === "string" ? a.errorSeverity : "error",
        message: typeof a.message === "string" ? a.message : "translation error",
        startLine: typeof a.startLine === "number" ? a.startLine : undefined,
        startChar: typeof a.startChar === "number" ? a.startChar : undefined,
        endLine: typeof a.endLine === "number" ? a.endLine : undefined,
        endChar: typeof a.endChar === "number" ? a.endChar : undefined,
      });
    }
  }
  return out;
}

// ---- CQL source reconstruction from a compiled ELM's annotation narrative -----
interface Narr {
  r?: string;
  s?: Narr[];
  value?: string[];
}
function flattenNarrative(n: Narr | undefined): string {
  if (!n) return "";
  if (n.value) return n.value.join("");
  if (n.s) return n.s.map(flattenNarrative).join("");
  return "";
}
function startLine(locator: unknown): number {
  if (typeof locator !== "string") return Number.MAX_SAFE_INTEGER;
  const n = parseInt(locator.split(":")[0] ?? "", 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Rebuild the original CQL text from a compiled ELM (requires EnableAnnotations).
 * Walks every annotated declaration (using/include/codesystem/valueset/parameter/
 * context/define) in source order and concatenates its narrative. Used to seed the
 * live editor with real, recompilable measure CQL.
 */
export function reconstructCql(elm: unknown): string {
  const lib = (elm as { library?: Record<string, { def?: { locator?: string; annotation?: { s?: Narr }[] }[] }> & { annotation?: { type?: string; s?: Narr }[] } })?.library;
  if (!lib) return "";
  const parts: { line: number; text: string }[] = [];
  for (const ann of lib.annotation ?? []) {
    if (ann.type === "Annotation" && ann.s) parts.push({ line: 1, text: flattenNarrative(ann.s) });
  }
  for (const section of ["usings", "includes", "codeSystems", "valueSets", "parameters", "contexts", "statements"]) {
    for (const def of lib[section]?.def ?? []) {
      const narr = def.annotation?.[0]?.s;
      if (narr) parts.push({ line: startLine(def.locator), text: flattenNarrative(narr) });
    }
  }
  parts.sort((a, b) => a.line - b.line);
  return parts
    .map((p) => p.text)
    .join("\n")
    .replace(/^\n+/, "")
    .trimEnd();
}

/** Translate CQL text → ELM JSON in-process (no JVM). Never throws on CQL errors —
 *  errors come back as diagnostics with `ok: false` so the UI can render them. */
export function compileCql(cqlText: string): CompileResult {
  let elm: unknown;
  try {
    const json = (CqlTranslator.fromText(cqlText, manager()) as { toJson(): string }).toJson();
    elm = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      elm: null,
      diagnostics: [{ severity: "error", message: String((err as Error)?.message ?? err) }],
    };
  }
  const diagnostics = extractDiagnostics(elm as { library?: { annotation?: unknown[] } });
  return { ok: !diagnostics.some((d) => d.severity.toLowerCase() === "error"), elm, diagnostics };
}
