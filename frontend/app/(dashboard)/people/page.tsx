"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { SkeletonCard } from "@/components/skeleton-loader";

/**
 * E15 PR-1 — cross-system People directory. Resolves one person across ≥1 WebChart systems and
 * surfaces DUPLICATE candidates (same person in >1 system). Read-only; consumes
 * GET /api/identity/people. Identity groups/follows — it never decides compliance (ADR-008).
 */

type SourceLink = {
  tenantId: string;
  tenantName: string;
  externalId: string;
  name: string;
  role: string;
  site: string;
  status: "ACTIVE" | "PRIOR";
  moveDate?: string;
};

type Person = {
  personId: string;
  displayName: string;
  nationalId: string | null;
  crossSystem: boolean;
  sources: SourceLink[];
};

export default function PeoplePage() {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ pageSize: "50" });
      if (query.trim()) qs.set("q", query.trim());
      const res = await api.getWithHeaders<Person[]>(`/api/identity/people?${qs.toString()}`);
      setPeople(res.data);
      setTotal(Number(res.headers.get("X-Total-Count") ?? res.data.length));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoaded(true);
    }
  }, [api, query]);

  // Debounce the search a touch so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">People</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Cross-system person directory — one person resolved across every WebChart system, with a
          DUPLICATE badge when the same person appears in more than one. Identity groups and follows a
          person across a move; it never changes compliance.
        </p>
      </div>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, employee id, or national id…"
        aria-label="Search people"
        className="w-full max-w-md rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
      />

      {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}

      {!loaded ? (
        <div className="grid gap-3 md:grid-cols-2">{[0, 1].map((i) => <SkeletonCard key={i} />)}</div>
      ) : people.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No people match that search.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <table className="min-w-full text-sm">
            <caption className="sr-only">Resolved people across all WebChart systems ({total} total)</caption>
            <thead className="text-left text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                <th scope="col" className="px-4 py-2">Person</th>
                <th scope="col" className="px-4 py-2">Systems</th>
                <th scope="col" className="px-4 py-2">Identity</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.personId} className="border-b border-neutral-100 dark:border-neutral-800/60 hover:bg-neutral-50 dark:hover:bg-neutral-800/50">
                  <td className="px-4 py-2">
                    <Link href={`/people/${encodeURIComponent(p.personId)}`} className="font-medium text-primary-700 dark:text-primary-400 hover:underline">
                      {p.displayName}
                    </Link>
                    {p.crossSystem ? (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                        Duplicate
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-neutral-600 dark:text-neutral-400">
                    {p.sources.map((s) => (
                      <span key={s.externalId} className="mr-1 inline-block">
                        {s.tenantName}
                        {s.status === "PRIOR" ? <span className="text-neutral-400"> (prior)</span> : null}
                        {p.sources.indexOf(s) < p.sources.length - 1 ? "," : ""}
                      </span>
                    ))}
                  </td>
                  <td className="px-4 py-2 text-neutral-500 dark:text-neutral-400">{p.nationalId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
