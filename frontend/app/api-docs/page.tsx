"use client";

/**
 * The public API reference (ADR-068).
 *
 * A top-level route, NOT inside `app/(dashboard)/`, and deliberately unauthenticated: the document it
 * renders is public, and an integrator should be able to read the contract before they have credentials.
 * That is most of what this page is for.
 *
 * It fetches with a plain `fetch` rather than through `lib/api/client`, because that client attaches a
 * bearer token and drives the silent-refresh/logout flow on a 401 — behaviour that makes sense for the
 * dashboard and would be wrong on a page nobody is logged into.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { ApiReference } from "@/components/api-docs/api-reference";
import type { OpenApiDoc } from "@/components/api-docs/types";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
const SPEC_PATH = "/api/v1/openapi.json";
const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "WorkWell Measure Studio";

export default function ApiDocsPage() {
  const [doc, setDoc] = useState<OpenApiDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}${SPEC_PATH}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`the API returned ${res.status}`);
        return (await res.json()) as OpenApiDoc;
      })
      .then((d) => { if (active) setDoc(d); })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, []);

  const specUrl = `${API_BASE}${SPEC_PATH}`;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{APP_NAME}</p>
        <h1 className="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          {doc?.info?.title ?? "Integration API"}
        </h1>
        {doc?.info?.summary && <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{doc.info.summary}</p>}
        <p className="mt-3 text-xs text-neutral-500">
          OpenAPI {doc?.openapi ?? "3.1"} ·{" "}
          <a className="underline hover:no-underline" href={specUrl}>machine-readable document</a> ·{" "}
          <Link className="underline hover:no-underline" href="/">Studio</Link>
        </p>
      </header>

      {doc?.info?.description && (
        <div className="mb-8 space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs leading-relaxed text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          {doc.info.description.split("\n\n").map((para, i) => (
            <p key={i} className="whitespace-pre-line">{para}</p>
          ))}
        </div>
      )}

      {error && (
        // Honest, and specific about which of the two failures this is — an unreachable API and an API with
        // no document are different problems for whoever is reading.
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-semibold">The API reference could not be loaded.</p>
          <p className="mt-1 text-xs">
            Fetching <code className="font-mono">{specUrl}</code> failed: {error}. The document is served by the
            backend, so this page is empty whenever the backend is unreachable.
          </p>
        </div>
      )}

      {!doc && !error && <p className="text-sm text-neutral-500">Loading the API reference…</p>}
      {doc && <ApiReference doc={doc} origin={API_BASE || "https://<your-workwell-host>"} />}
    </main>
  );
}
