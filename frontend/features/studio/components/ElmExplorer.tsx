"use client";

/**
 * ELM Explorer (issue #96) — live CQL → AST, no JVM.
 *
 * CQL is the human-authored source of truth; the `cql-to-elm` translator (ANTLR4,
 * pure Node via @cqframework/cql — no JVM) compiles it to ELM, the Expression
 * Logical Model = the AST that the Node engine (`cql-execution`) tree-walks to
 * compute compliance. This panel lets you EDIT CQL and watch the AST rebuild in
 * real time (debounced recompile against POST /api/measures/compile), surfaces
 * translator diagnostics, and lets you click an AST node to jump to the exact CQL
 * span it came from (via the node's `locator`). Read-only w.r.t. compliance — the
 * canonical `Outcome Status` define remains the sole source of truth.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---- shapes ------------------------------------------------------------------
interface ElmNode {
  type?: string;
  localId?: string;
  locator?: string;
  [k: string]: unknown;
}
interface ElmDefine extends ElmNode {
  name: string;
  expression?: ElmNode;
}
export interface ElmLibrary {
  library?: {
    identifier?: { id?: string; version?: string };
    statements?: { def?: ElmDefine[] };
  };
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
  elm: ElmLibrary | null;
  diagnostics: CqlDiagnostic[];
}

const CANONICAL_DEFINE = "Outcome Status";

// ---- locator → textarea offset (CQL locators are 1-based "L:C-L:C") -----------
function offsetFromLineChar(text: string, line: number, char: number): number {
  const lines = text.split("\n");
  let off = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i]!.length + 1;
  return off + (char - 1);
}
function locatorRange(text: string, locator?: string): { start: number; end: number } | null {
  const m = locator?.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
  if (!m) return null;
  return {
    start: offsetFromLineChar(text, +m[1]!, +m[2]!),
    end: offsetFromLineChar(text, +m[3]!, +m[4]!) + 1,
  };
}

// ---- AST tree, collapsible, keyed on node.type --------------------------------
const CHILD_KEYS_SKIP = new Set(["localId", "locator", "annotation", "type"]);
function isElmNode(v: unknown): v is ElmNode {
  return !!v && typeof v === "object" && "type" in (v as object);
}
function nodeSummary(node: ElmNode): string {
  const bits: string[] = [];
  for (const key of ["name", "path", "value", "valueType", "precision", "operator"]) {
    const v = node[key];
    if (typeof v === "string" || typeof v === "number") bits.push(`${key}=${v}`);
  }
  return bits.join("  ");
}

function AstNode({
  node,
  label,
  depth,
  selected,
  onSelect,
}: {
  node: ElmNode;
  label: string;
  depth: number;
  selected: string | null;
  onSelect: (node: ElmNode) => void;
}) {
  const [open, setOpen] = useState(depth < 3);
  const childEntries: { key: string; node: ElmNode }[] = [];
  for (const [key, val] of Object.entries(node)) {
    if (CHILD_KEYS_SKIP.has(key)) continue;
    if (isElmNode(val)) childEntries.push({ key, node: val });
    else if (Array.isArray(val)) val.forEach((v, i) => isElmNode(v) && childEntries.push({ key: `${key}[${i}]`, node: v }));
  }
  const hasChildren = childEntries.length > 0;
  const isSel = !!node.localId && node.localId === selected;
  const summary = nodeSummary(node);

  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 14 }}>
      {/* The expand/collapse toggle and the select-source target are SIBLINGS (not nested) so
          neither interactive control is a descendant of the other (avoids nested-interactive). */}
      <div
        className={`flex items-baseline gap-2 rounded px-1 py-0.5 font-mono text-xs ${isSel ? "bg-amber-300/70 dark:bg-amber-500/40" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"}`}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="w-3 shrink-0 text-neutral-500"
            aria-label={open ? "collapse" : "expand"}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span
          role="button"
          tabIndex={0}
          aria-label={`Highlight CQL source for ${node.type ?? "node"}`}
          onClick={() => onSelect(node)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(node);
            }
          }}
          className="flex flex-1 cursor-pointer items-baseline gap-2"
          title={node.locator ? `locator ${node.locator} — click to highlight source` : undefined}
        >
          <span className="text-neutral-400">{label}:</span>
          <span className="font-semibold text-sky-700 dark:text-sky-300">{node.type ?? "?"}</span>
          {summary ? <span className="text-neutral-500">{summary}</span> : null}
        </span>
      </div>
      {open && hasChildren ? (
        <div className="border-l border-neutral-200 dark:border-neutral-800">
          {childEntries.map((c) => (
            <AstNode key={c.key} node={c.node} label={c.key} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---- main --------------------------------------------------------------------
export function ElmExplorer({
  initialCql,
  initialElm,
  onCompile,
}: {
  initialCql: string;
  initialElm: ElmLibrary;
  onCompile: (cql: string) => Promise<CompileResult>;
}) {
  const [cql, setCql] = useState(initialCql);
  const [elm, setElm] = useState<ElmLibrary>(initialElm);
  const [diagnostics, setDiagnostics] = useState<CqlDiagnostic[]>([]);
  const [status, setStatus] = useState<"idle" | "compiling" | "ok" | "error">("ok");
  const [activeDefine, setActiveDefine] = useState<string>("");
  const [selectedLocalId, setSelectedLocalId] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const seq = useRef(0);
  const seededCompile = useRef(false);

  const defines = useMemo(() => elm.library?.statements?.def ?? [], [elm]);
  // Derive the shown define (no state-sync effect): explicit selection, else the
  // canonical Outcome Status define, else the first — robust as the live ELM changes.
  const current =
    defines.find((d) => d.name === activeDefine) ?? defines.find((d) => d.name === CANONICAL_DEFINE) ?? defines[0];

  // Debounced live recompile. Two invariants:
  //  1. Depend ONLY on the edited CQL — never on `status`, which this effect sets;
  //     depending on it would reschedule a compile after every completion and turn
  //     one edit into an endless POST /compile loop.
  //  2. Bump `seq` SYNCHRONOUSLY on every CQL change (not inside the timeout), so any
  //     already-in-flight compile is invalidated the moment the source changes —
  //     including when the user reverts to the seed before an earlier response lands.
  //     Otherwise a stale response could overwrite the editor's current AST/diagnostics.
  // The very first run is the server-seeded compile, so it's skipped (no recompile).
  useEffect(() => {
    const mySeq = ++seq.current;
    if (!seededCompile.current) {
      seededCompile.current = true;
      return; // seed (initialElm) already compiled server-side
    }
    const handle = window.setTimeout(async () => {
      setStatus("compiling");
      try {
        const result = await onCompile(cql);
        if (mySeq !== seq.current) return; // a newer edit superseded this
        setDiagnostics(result.diagnostics ?? []);
        if (result.elm?.library) setElm(result.elm);
        setStatus(result.ok ? "ok" : "error");
      } catch {
        if (mySeq !== seq.current) return;
        setStatus("error");
        setDiagnostics([{ severity: "error", message: "Compile request failed" }]);
      }
    }, 550);
    return () => window.clearTimeout(handle);
  }, [cql, onCompile]);

  const jumpTo = useCallback(
    (locator?: string, line?: number, char?: number) => {
      const ta = taRef.current;
      if (!ta) return;
      const range = locator ? locatorRange(cql, locator) : line ? { start: offsetFromLineChar(cql, line, char ?? 1), end: offsetFromLineChar(cql, line, char ?? 1) + 1 } : null;
      if (!range) return;
      ta.focus();
      ta.setSelectionRange(range.start, Math.max(range.end, range.start + 1));
    },
    [cql],
  );

  const errorCount = diagnostics.filter((d) => d.severity.toLowerCase() === "error").length;
  const warnCount = diagnostics.filter((d) => d.severity.toLowerCase() === "warning").length;

  return (
    <div className="space-y-3">
      {/* status bar */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span
          className={`rounded-full px-2 py-0.5 font-medium ${
            status === "compiling"
              ? "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300"
              : status === "error"
                ? "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300"
                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
          }`}
        >
          {status === "compiling" ? "compiling…" : status === "error" ? `✗ ${errorCount} error${errorCount === 1 ? "" : "s"}` : "✓ compiled"}
        </span>
        <span className="text-neutral-500">CQL → ELM in Node · no JVM</span>
        {warnCount > 0 ? <span className="text-amber-600 dark:text-amber-400">{warnCount} warning{warnCount === 1 ? "" : "s"}</span> : null}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* editor */}
        <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">CQL source — edit to recompile</p>
          <textarea
            ref={taRef}
            aria-label="CQL source"
            value={cql}
            onChange={(e) => setCql(e.target.value)}
            spellCheck={false}
            rows={22}
            className="w-full resize-y rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-xs leading-relaxed text-neutral-800 outline-none focus:border-sky-400 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200"
          />
        </div>

        {/* AST */}
        <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-1">
            {defines.map((d) => (
              <button
                key={d.name}
                onClick={() => {
                  setActiveDefine(d.name);
                  setSelectedLocalId(null);
                }}
                className={`rounded px-2 py-0.5 text-xs ${
                  d.name === (current?.name ?? "")
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {d.name}
                {d.name === CANONICAL_DEFINE ? " ★" : ""}
              </button>
            ))}
          </div>
          {current?.expression ? (
            <div className="max-h-[28rem] overflow-auto">
              <AstNode
                node={current.expression}
                label="expression"
                depth={0}
                selected={selectedLocalId}
                onSelect={(node) => {
                  setSelectedLocalId(node.localId ?? null);
                  jumpTo(node.locator);
                }}
              />
            </div>
          ) : (
            <p className="text-xs text-neutral-500">{defines.length ? "(no expression for this define)" : "(no compiled statements)"}</p>
          )}
        </div>
      </div>

      {/* diagnostics */}
      {diagnostics.length > 0 ? (
        <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Diagnostics</p>
          <ul className="space-y-1 text-xs">
            {diagnostics.map((d, i) => (
              <li key={`${d.severity}-${d.startLine ?? "?"}-${d.startChar ?? "?"}-${d.message}-${i}`}>
                <button
                  onClick={() => jumpTo(undefined, d.startLine, d.startChar)}
                  className={`text-left hover:underline ${d.severity.toLowerCase() === "error" ? "text-red-700 dark:text-red-300" : "text-amber-600 dark:text-amber-400"}`}
                >
                  <span className="font-mono">
                    [{d.severity}]{d.startLine ? ` ${d.startLine}:${d.startChar ?? 1}` : ""}
                  </span>{" "}
                  {d.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Click an AST node to highlight the CQL span it came from (via <code>locator</code>). ★ marks the canonical{" "}
        <code>{CANONICAL_DEFINE}</code> define — the sole source of compliance truth (AI never decides compliance).
      </p>
    </div>
  );
}
