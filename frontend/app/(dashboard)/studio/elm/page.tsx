"use client";

/**
 * ELM Explorer page (issue #96 demo). Lists the runnable measures from the
 * JVM-free TS engine and renders the compiled ELM (AST) ↔ CQL source for the
 * selected one. Talks to the TS backend over the same fetch contract as every
 * other surface (GET /api/measures, GET /api/measures/:id/elm) — when the
 * frontend is pointed at the Node backend this is the strangler's own
 * "frontend talks to the TS endpoints unchanged" validation.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api/hooks";
import { ElmExplorer, type CompileResult, type ElmLibrary } from "@/features/studio/components/ElmExplorer";

interface MeasureRow {
  id: string;
  name: string;
}
interface ElmResponse {
  measureId: string;
  name: string;
  library: string;
  cql: string;
  elm: ElmLibrary;
}

export default function ElmExplorerPage() {
  const api = useApi();
  const [measures, setMeasures] = useState<MeasureRow[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [data, setData] = useState<ElmResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const compile = useCallback(
    (cqlText: string) => api.post<{ cql: string }, CompileResult>("/api/measures/compile", { cql: cqlText }),
    [api],
  );

  useEffect(() => {
    void (async () => {
      try {
        const rows = await api.get<MeasureRow[]>("/api/measures");
        setMeasures(rows ?? []);
        if (rows?.length) setSelectedId(rows[0]!.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load measures");
      }
    })();
  }, [api]);

  useEffect(() => {
    if (!selectedId) return;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get<ElmResponse>(`/api/measures/${selectedId}/elm`);
        setData(res ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load ELM");
        setData(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [api, selectedId]);

  return (
    <section className="space-y-4">
      <div>
        <Link href="/measures" className="text-xs text-neutral-500 dark:text-neutral-400 hover:underline">
          Back to Measures
        </Link>
        <h2 className="text-2xl font-semibold">ELM Explorer</h2>
        <p className="mt-1 max-w-3xl text-sm text-neutral-600 dark:text-neutral-400">
          CQL is the human-authored source of truth; the translator compiles it to <strong>ELM</strong> — the
          Expression Logical Model, the AST that the Node engine executes to compute compliance. Edit the CQL on the
          left and watch the AST rebuild in real time — the <code>cql-to-elm</code> translator runs in Node, with no
          JVM in the path. Click any AST node to highlight the CQL span it came from.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="measure" className="text-sm text-neutral-600 dark:text-neutral-400">
          Measure
        </label>
        <select
          id="measure"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          {measures.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {data ? <span className="font-mono text-xs text-neutral-500">{data.library}</span> : null}
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {loading ? <p className="text-sm text-neutral-600 dark:text-neutral-400">Loading ELM…</p> : null}
      {data && !loading ? (
        <ElmExplorer key={data.measureId} initialCql={data.cql} initialElm={data.elm} onCompile={compile} />
      ) : null}
    </section>
  );
}
