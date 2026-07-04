"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { useAuth } from "@/components/auth-provider";
import { AccessDenied } from "@/components/access-denied";
import { canViewPeople } from "@/lib/rbac";
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

/**
 * A cross-system person is either MOVED (has a PRIOR system — one person, continuous history) or a
 * DUPLICATE (active in >1 system). These are the two distinct E15 stories, so the badge must not
 * conflate them.
 */
function crossSystemBadge(p: Person): { label: string; cls: string } | null {
  if (!p.crossSystem) return null;
  if (p.sources.some((s) => s.status === "PRIOR")) {
    return { label: "Moved", cls: "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300" };
  }
  return { label: "Duplicate", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" };
}

export default function PeoplePage() {
  const api = useApi();
  const { user } = useAuth();
  const mayView = canViewPeople(user?.role);
  const PAGE_SIZE = 50;
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [people, setPeople] = useState<Person[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stale-fetch guard (Fable M20): a slow response for an earlier query/page must not overwrite a
  // newer one's results. Every load takes the next request id; only the latest applies its result.
  const reqIdRef = useRef(0);
  const load = useCallback(async () => {
    // /api/identity/** is CASE_MANAGER/ADMIN-gated on the backend — skip the fetch for other roles
    // so a deep-link never fires a guaranteed 403 (the page renders an access-denied state below).
    if (!mayView) return;
    const reqId = ++reqIdRef.current;
    try {
      const qs = new URLSearchParams({ pageSize: String(PAGE_SIZE), page: String(page) });
      if (query.trim()) qs.set("q", query.trim());
      const res = await api.getWithHeaders<Person[]>(`/api/identity/people?${qs.toString()}`);
      if (reqId !== reqIdRef.current) return;
      setPeople(res.data);
      setTotal(Number(res.headers.get("X-Total-Count") ?? res.data.length));
      setError(null);
    } catch (err) {
      if (reqId !== reqIdRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (reqId === reqIdRef.current) setLoaded(true);
    }
  }, [api, query, page, mayView]);

  // Debounce the search a touch so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Deep-link guard: the nav already hides People from non-CM roles, but a pasted URL would
  // otherwise mount the directory and fire a guaranteed 403 fetch. Render a clean access-denied
  // state instead (mirrors /campaigns and /orders).
  if (!mayView) {
    return (
      <AccessDenied
        title="People"
        message="The cross-system People directory is managed by Case Managers and Admins — your role doesn’t have access."
      />
    );
  }

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
        onChange={(e) => {
          setQuery(e.target.value);
          setPage(1); // reset to the first page when the search changes
        }}
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
                    {(() => {
                      const badge = crossSystemBadge(p);
                      return badge ? (
                        <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badge.cls}`}>
                          {badge.label}
                        </span>
                      ) : null;
                    })()}
                  </td>
                  <td className="px-4 py-2 text-neutral-600 dark:text-neutral-400">
                    {p.sources.map((s) => (
                      // Composite key: with multi-tenant data the same externalId can appear across
                      // systems, so tenantId alone doesn't dedupe — tenantId + externalId is unique
                      // (matches the merge-picker's composite key on /people/[personId]).
                      <span key={`${s.tenantId}|${s.externalId}`} className="mr-1 inline-block">
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

      {loaded && people.length > 0 && totalPages > 1 ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-neutral-500 dark:text-neutral-400">
            Page {page} of {totalPages} · {total} people
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-1 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-1 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
