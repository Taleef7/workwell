"use client";

/**
 * ELM Explorer (issue #96 demo) — source ↔ AST side-by-side for a compiled measure.
 *
 * The CQL `cql-to-elm` translator (ANTLR4, run at build time, no JVM at runtime)
 * emits the ELM: the Expression Logical Model, i.e. the AST that the Node engine
 * (`cql-execution`) tree-walks to compute compliance. This panel renders that AST
 * next to the CQL source it came from, linked by `localId`:
 *   - left:  CQL source, reconstructed from the ELM annotation narrative (each
 *            span carries the `localId` of the node it produced — EnableAnnotations)
 *   - right: the AST, a collapsible tree keyed on each node's `type`
 * Click either side to highlight the matching node on the other. Read-only — this
 * never decides compliance; it just makes "CQL → AST → evaluate" tangible.
 */
import { useMemo, useState } from "react";

// ---- minimal ELM shapes (the translator output is otherwise `unknown`) --------
interface Narrative {
  r?: string;
  s?: Narrative[];
  value?: string[];
}
interface ElmNode {
  type?: string;
  localId?: string;
  locator?: string;
  [k: string]: unknown;
}
interface ElmDefine extends ElmNode {
  name: string;
  expression?: ElmNode;
  annotation?: { s?: Narrative }[];
}
export interface ElmLibrary {
  library?: {
    identifier?: { id?: string; version?: string };
    statements?: { def?: ElmDefine[] };
  };
}

/** The canonical compliance define — worth calling out in the demo. */
const CANONICAL_DEFINE = "Outcome Status";

// ---- left pane: CQL source rebuilt from the annotation narrative --------------
function NarrativeText({
  node,
  selected,
  onSelect,
}: {
  node: Narrative;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const children = node.s
    ? node.s.map((child, i) => <NarrativeText key={i} node={child} selected={selected} onSelect={onSelect} />)
    : node.value?.join("") ?? "";

  if (!node.r) return <>{children}</>;
  const isSel = node.r === selected;
  return (
    <span
      data-r={node.r}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(isSel ? null : node.r ?? null);
      }}
      className={`cursor-pointer rounded-sm ${isSel ? "bg-amber-300/70 dark:bg-amber-500/40" : "hover:bg-amber-200/40 dark:hover:bg-amber-500/20"}`}
    >
      {children}
    </span>
  );
}

// ---- right pane: the AST, collapsible, keyed on node.type ---------------------
const CHILD_KEYS_SKIP = new Set(["localId", "locator", "annotation", "type"]);

/** A short inline summary of a node's scalar fields (value, name, path, …). */
function nodeSummary(node: ElmNode): string {
  const bits: string[] = [];
  for (const key of ["name", "path", "value", "valueType", "precision", "operator"]) {
    const v = node[key];
    if (typeof v === "string" || typeof v === "number") bits.push(`${key}=${v}`);
  }
  return bits.join("  ");
}

function isElmNode(v: unknown): v is ElmNode {
  return !!v && typeof v === "object" && "type" in (v as object);
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
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
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
      <div
        onClick={() => onSelect(isSel ? null : node.localId ?? null)}
        className={`flex cursor-pointer items-baseline gap-2 rounded px-1 py-0.5 font-mono text-xs ${isSel ? "bg-amber-300/70 dark:bg-amber-500/40" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"}`}
        title={node.locator ? `locator ${node.locator}` : undefined}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
            className="w-3 shrink-0 text-neutral-500"
            aria-label={open ? "collapse" : "expand"}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="text-neutral-400">{label}:</span>
        <span className="font-semibold text-sky-700 dark:text-sky-300">{node.type ?? "?"}</span>
        {summary ? <span className="text-neutral-500">{summary}</span> : null}
      </div>
      {open && hasChildren ? (
        <div className="border-l border-neutral-200 dark:border-neutral-800">
          {childEntries.map((c, i) => (
            <AstNode key={i} node={c.node} label={c.key} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ElmExplorer({ elm }: { elm: ElmLibrary }) {
  const [selected, setSelected] = useState<string | null>(null);
  const defines = useMemo(() => elm.library?.statements?.def ?? [], [elm]);
  const [activeDefine, setActiveDefine] = useState<string>(() => defines[0]?.name ?? "");
  const current = defines.find((d) => d.name === activeDefine) ?? defines[0];

  if (defines.length === 0) {
    return <p className="text-sm text-neutral-600 dark:text-neutral-400">No ELM statements found.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {defines.map((d) => (
          <button
            key={d.name}
            onClick={() => {
              setActiveDefine(d.name);
              setSelected(null);
            }}
            className={`rounded-md px-2 py-1 text-xs ${
              d.name === activeDefine
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            }`}
          >
            {d.name}
            {d.name === CANONICAL_DEFINE ? " ★" : ""}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">CQL source</p>
          <pre className="overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-neutral-800 dark:text-neutral-200">
            {current?.annotation?.[0]?.s ? (
              <NarrativeText node={current.annotation[0].s} selected={selected} onSelect={setSelected} />
            ) : (
              "(no source annotation)"
            )}
          </pre>
        </div>

        <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            ELM (AST){current?.expression?.type ? <span className="ml-2 font-normal normal-case text-neutral-400">root: {current.expression.type}</span> : null}
          </p>
          {current?.expression ? (
            <AstNode node={current.expression} label="expression" depth={0} selected={selected} onSelect={setSelected} />
          ) : (
            <p className="text-xs text-neutral-500">(no expression)</p>
          )}
        </div>
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Click a span on the left or a node on the right to highlight the matching node (linked by <code>localId</code>). ★ marks the
        canonical <code>{CANONICAL_DEFINE}</code> define — the sole source of compliance truth.
      </p>
    </div>
  );
}
