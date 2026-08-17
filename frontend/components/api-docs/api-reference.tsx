"use client";

/**
 * The API reference page's renderer (ADR-068) — an OpenAPI 3.1 document as a readable page.
 *
 * ## Why this is hand-rolled
 *
 * Swagger UI's React integration is unusable here: `swagger-ui-react` peers on `react@">=16.8 <19"` and this
 * app is on React 19, so the only route would be injecting `swagger-ui-dist` by hand — 1.7 MB of vendored
 * JS, a stylesheet whose class names are internal and unversioned, and a dark mode implemented as a
 * hard-coded `html.dark-mode` class that would fight this app for ownership of `<html>`. Scalar and Redoc
 * both default to a CDN script, which the CSP and the offline demo rule out, and self-hosting either means
 * vendoring a megabyte-plus bundle for seven operations.
 *
 * So: no dependency, no vendored asset, and the page inherits the Enterprise Health brand and dark mode it
 * already has (ADR-004). The trade is that there is no "try it out" console — a reader gets a copyable
 * `curl` instead, which for a bearer-token API is roughly as useful and does not need a proxy.
 *
 * Schemas render as a flat indented property list rather than an expanding tree, because two levels is all
 * this document has.
 */
import { useState } from "react";
import { Badge } from "@mieweb/ui";
import { endpointsOf, resolve, typeLabel, type Endpoint, type OpenApiDoc, type Schema } from "./types";

const METHOD_TONE: Record<string, string> = {
  GET: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30",
  POST: "bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/30",
};

function MethodBadge({ method }: { method: string }) {
  const tone = METHOD_TONE[method] ?? "bg-neutral-500/10 text-neutral-700 dark:text-neutral-300 ring-neutral-500/30";
  return (
    <span className={`inline-flex shrink-0 items-center rounded px-2 py-0.5 font-mono text-xs font-semibold ring-1 ring-inset ${tone}`}>
      {method}
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => setCopied(false),
        );
      }}
      className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** One row per property, indented by depth. `$ref` is followed one level; deeper nesting is summarised. */
function SchemaRows({ schema, doc, depth = 0 }: { schema: Schema | undefined; doc: OpenApiDoc; depth?: number }) {
  const resolved = resolve(schema, doc);
  if (!resolved) return null;
  const props = resolved.properties ?? resolve(resolved.items, doc)?.properties;
  const required = new Set(resolved.required ?? resolve(resolved.items, doc)?.required ?? []);
  if (!props) return null;

  return (
    <>
      {Object.entries(props).map(([name, prop]) => {
        const child = resolve(prop, doc);
        const nested = depth < 2 && (child?.properties || resolve(child?.items, doc)?.properties);
        return (
          <div key={`${depth}-${name}`}>
            <div className="flex flex-wrap items-baseline gap-x-2 border-t border-neutral-200/60 py-1.5 dark:border-neutral-800/60" style={{ paddingLeft: `${depth * 1}rem` }}>
              <code className="font-mono text-xs text-neutral-900 dark:text-neutral-100">{name}</code>
              <span className="font-mono text-[11px] text-neutral-500">{typeLabel(prop)}</span>
              {required.has(name) && <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">required</span>}
              {(prop.enum ?? child?.enum) && (
                <span className="font-mono text-[11px] text-neutral-500">{(prop.enum ?? child?.enum)!.join(" | ")}</span>
              )}
              {(prop.description ?? child?.description) && (
                <span className="basis-full text-xs text-neutral-600 dark:text-neutral-400" style={{ paddingLeft: `${depth * 1}rem` }}>
                  {prop.description ?? child?.description}
                </span>
              )}
            </div>
            {nested ? <SchemaRows schema={prop} doc={doc} depth={depth + 1} /> : null}
          </div>
        );
      })}
    </>
  );
}

function curlFor(e: Endpoint, doc: OpenApiDoc, origin: string): string {
  const path = (e.op.parameters ?? [])
    .filter((p) => p.in === "path")
    .reduce((acc, p) => acc.replace(`{${p.name}}`, String(p.schema?.example ?? `<${p.name}>`)), e.path);
  const authed = (e.op.security ?? []).length > 0;
  const lines = [`curl -sS${e.method === "GET" ? "" : ` -X ${e.method}`} ${origin}${path}`];
  if (authed) lines.push(`  -H 'authorization: Bearer <token>'`);
  const bodySchema = resolve(e.op.requestBody?.content?.["application/json"]?.schema, doc);
  if (bodySchema) {
    lines.push(`  -H 'content-type: application/json'`);
    lines.push(`  -d '${JSON.stringify(exampleOf(bodySchema, doc))}'`);
  }
  return lines.join(" \\\n");
}

/** A minimal example object from a schema — required properties only, so the curl stays short and valid. */
function exampleOf(schema: Schema | undefined, doc: OpenApiDoc, depth = 0): unknown {
  const s = resolve(schema, doc);
  if (!s || depth > 3) return {};
  if (s.example !== undefined) return s.example;
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (types.includes("array")) return [exampleOf(s.items, doc, depth + 1)];
  if (types.includes("object") || s.properties) {
    const out: Record<string, unknown> = {};
    for (const name of s.required ?? []) out[name] = exampleOf(s.properties?.[name], doc, depth + 1);
    return out;
  }
  if (s.enum?.length) return s.enum[0];
  if (types.includes("boolean")) return false;
  return s.example ?? "string";
}

function OperationCard({ e, doc, origin }: { e: Endpoint; doc: OpenApiDoc; origin: string }) {
  const params = e.op.parameters ?? [];
  const authed = (e.op.security ?? []).length > 0;
  const curl = curlFor(e, doc, origin);
  const success = Object.entries(e.op.responses ?? {}).find(([code]) => code.startsWith("2"));
  const successSchema = success?.[1]?.content?.["application/json"]?.schema;
  const bodySchema = e.op.requestBody?.content?.["application/json"]?.schema;

  return (
    <section id={e.op.operationId} className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <header className="flex flex-wrap items-baseline gap-2">
        <MethodBadge method={e.method} />
        <code className="break-all font-mono text-sm text-neutral-900 dark:text-neutral-100">{e.path}</code>
        {authed ? <Badge>bearer token</Badge> : <Badge>public</Badge>}
      </header>
      <h3 className="mt-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">{e.op.summary}</h3>
      {e.op.description && (
        <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">{e.op.description}</p>
      )}

      {params.length > 0 && (
        <div className="mt-3">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Parameters</h4>
          <div className="mt-1 overflow-x-auto">
            {params.map((p) => (
              <div key={p.name} className="flex flex-wrap items-baseline gap-x-2 border-t border-neutral-200/60 py-1.5 dark:border-neutral-800/60">
                <code className="font-mono text-xs text-neutral-900 dark:text-neutral-100">{p.name}</code>
                <span className="font-mono text-[11px] text-neutral-500">{p.in}</span>
                <span className="font-mono text-[11px] text-neutral-500">{typeLabel(p.schema)}</span>
                {p.required && <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">required</span>}
                {p.schema?.enum && <span className="font-mono text-[11px] text-neutral-500">{p.schema.enum.join(" | ")}</span>}
                {p.description && <span className="basis-full text-xs text-neutral-600 dark:text-neutral-400">{p.description}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {bodySchema && (
        <div className="mt-3">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Request body</h4>
          <div className="mt-1 overflow-x-auto"><SchemaRows schema={bodySchema} doc={doc} /></div>
        </div>
      )}

      {successSchema && (
        <div className="mt-3">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Response {success![0]} — {typeLabel(successSchema)}
          </h4>
          <div className="mt-1 overflow-x-auto"><SchemaRows schema={successSchema} doc={doc} /></div>
        </div>
      )}

      {Object.keys(e.op.responses ?? {}).length > 1 && (
        <div className="mt-3">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Status codes</h4>
          <div className="mt-1">
            {Object.entries(e.op.responses ?? {}).map(([code, r]) => (
              <div key={code} className="flex flex-wrap gap-x-2 border-t border-neutral-200/60 py-1.5 text-xs dark:border-neutral-800/60">
                <code className="font-mono text-neutral-900 dark:text-neutral-100">{code}</code>
                <span className="text-neutral-600 dark:text-neutral-400">{r.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3">
        <div className="flex items-center justify-between">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Example</h4>
          <CopyButton text={curl} label={`Copy curl for ${e.op.operationId}`} />
        </div>
        <pre className="mt-1 overflow-x-auto rounded bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-neutral-100">{curl}</pre>
      </div>
    </section>
  );
}

export function ApiReference({ doc, origin }: { doc: OpenApiDoc; origin: string }) {
  const endpoints = endpointsOf(doc);
  if (endpoints.length === 0) {
    // An honest empty state, not a blank page: the difference between "no operations" and "the document
    // could not be read" matters to whoever is looking at this.
    return (
      <p className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
        This OpenAPI document describes no operations.
      </p>
    );
  }
  const tags = doc.tags?.length ? doc.tags : [{ name: "", description: undefined }];

  return (
    <div className="space-y-8">
      {tags.map((tag) => {
        const inTag = endpoints.filter((e) => (tag.name ? (e.op.tags ?? []).includes(tag.name) : true));
        if (inTag.length === 0) return null;
        return (
          <div key={tag.name || "all"}>
            {tag.name && (
              <div className="mb-3">
                <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{tag.name}</h2>
                {tag.description && <p className="text-xs text-neutral-600 dark:text-neutral-400">{tag.description}</p>}
              </div>
            )}
            <div className="space-y-4">
              {inTag.map((e) => (
                <OperationCard key={e.op.operationId} e={e} doc={doc} origin={origin} />
              ))}
            </div>
          </div>
        );
      })}
      {/* Operations that carry no declared tag would otherwise render nowhere — silently dropping an
          operation from a reference page is the same defect class as a documented-but-unrouted path. */}
      {(() => {
        const tagged = new Set(tags.flatMap((t) => (t.name ? endpoints.filter((e) => (e.op.tags ?? []).includes(t.name)) : endpoints)).map((e) => e.op.operationId));
        const orphans = endpoints.filter((e) => !tagged.has(e.op.operationId));
        if (orphans.length === 0) return null;
        return (
          <div>
            <h2 className="mb-3 text-base font-semibold text-neutral-900 dark:text-neutral-100">Other</h2>
            <div className="space-y-4">
              {orphans.map((e) => (
                <OperationCard key={e.op.operationId} e={e} doc={doc} origin={origin} />
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
