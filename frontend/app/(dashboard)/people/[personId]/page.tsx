"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/api/hooks";
import { useAuth } from "@/components/auth-provider";
import { canReconcileIdentity } from "@/lib/rbac";
import { emitToast } from "@/lib/toast";
import { SkeletonCard } from "@/components/skeleton-loader";
import { OUTCOME_LABELS, labelFor } from "@/lib/status";

const OUTCOME_CHIP: Record<string, string> = {
  COMPLIANT: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  DUE_SOON: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  OVERDUE: "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  MISSING_DATA: "bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-300",
  EXCLUDED: "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
};

function OutcomeChip({ status }: { status: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${OUTCOME_CHIP[status] ?? "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"}`}>
      {labelFor(OUTCOME_LABELS, status)}
    </span>
  );
}

/**
 * E15 PR-1 — unified cross-system Person view: the linked source systems, a mobility banner when the
 * person moved (history continues from A → B), and a merged compliance timeline tagged with the system
 * each outcome came from. Read-only; consumes GET /api/identity/people/:personId. Descriptive only —
 * identity groups/follows, it never decides compliance (ADR-008).
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

type TimelineEntry = {
  measureId: string;
  measureName?: string;
  status: string;
  evaluatedAt: string;
  tenantId: string;
  tenantName: string;
  externalId: string;
  sourceStatus: "ACTIVE" | "PRIOR";
};

type PersonSearchRow = {
  personId: string;
  displayName: string;
  crossSystem: boolean;
  sources: SourceLink[];
};

type PersonDetail = {
  person: {
    personId: string;
    displayName: string;
    nationalId: string | null;
    dateOfBirth: string | null;
    crossSystem: boolean;
    sources: SourceLink[];
  };
  timeline: {
    entries: TimelineEntry[];
    move: { fromTenantName: string; toTenantName: string; date: string | null } | null;
  };
};

const fmt = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
};

// A calendar date (YYYY-MM-DD, e.g. a move date) is not a wall-clock instant — format it in UTC so a
// browser west of UTC doesn't render midnight-UTC as the previous local day.
const fmtDay = (day: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  });
};

export default function PersonDetailPage() {
  const params = useParams<{ personId: string }>();
  const personId = params.personId;
  const api = useApi();
  const router = useRouter();
  const { user } = useAuth();
  const mayReconcile = canReconcileIdentity(user?.role);
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!personId) return;
    try {
      setDetail(await api.get<PersonDetail>(`/api/identity/people/${encodeURIComponent(personId)}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [api, personId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Unlink a source record out of this person (it's not actually the same person). The person's id
  // changes when it splits, so route back to /people (which refetches) on success.
  const unlink = useCallback(
    async (src: SourceLink) => {
      if (!window.confirm(`Unlink ${src.tenantName} (${src.externalId}) — mark it as a different person?`)) return;
      setBusy(true);
      try {
        await api.post(`/api/identity/people/${encodeURIComponent(personId)}/reconcile`, {
          action: "UNLINK", tenantId: src.tenantId, externalId: src.externalId,
        });
        emitToast(`Unlinked ${src.tenantName} record`);
        router.push("/people");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setBusy(false);
      }
    },
    [api, personId, router],
  );

  // Merge-picker: search for a record that IS this person and link it in (CONFIRM_LINK). The inverse of
  // unlink — for two separately-resolved people who are actually the same human.
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeQuery, setMergeQuery] = useState("");
  const [mergeResults, setMergeResults] = useState<PersonSearchRow[]>([]);

  // Only FETCH in the effect (results are cleared in the input/toggle handlers, to avoid a synchronous
  // setState in the effect body).
  useEffect(() => {
    if (!mergeOpen || mergeQuery.trim().length < 2) return;
    // Ignore a fetch that resolves after this effect run is superseded — otherwise a slow earlier
    // request can overwrite newer results (stale-result race).
    let active = true;
    const timer = setTimeout(() => {
      void api
        .get<PersonSearchRow[]>(`/api/identity/people?q=${encodeURIComponent(mergeQuery.trim())}&pageSize=10`)
        .then((rows) => { if (active) setMergeResults(rows); })
        .catch(() => { if (active) setMergeResults([]); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [api, mergeOpen, mergeQuery]);

  const confirmLink = useCallback(
    async (src: { tenantId: string; tenantName: string; externalId: string; name: string }) => {
      if (!window.confirm(`Link ${src.name} — ${src.tenantName} (${src.externalId}) — as the same person?`)) return;
      setBusy(true);
      try {
        await api.post(`/api/identity/people/${encodeURIComponent(personId)}/reconcile`, {
          action: "CONFIRM_LINK", tenantId: src.tenantId, externalId: src.externalId,
        });
        emitToast(`Linked ${src.tenantName} record`);
        setMergeOpen(false);
        setMergeQuery("");
        router.push("/people");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setBusy(false);
      }
    },
    [api, personId, router],
  );

  // Records already part of this person — excluded from the picker so you can't link a member to itself.
  const ownRefs = new Set((detail?.person.sources ?? []).map((s) => `${s.tenantId}|${s.externalId}`));

  return (
    <section className="space-y-4">
      <Link href="/people" className="text-sm text-neutral-500 dark:text-neutral-400 hover:underline">← Back to People</Link>
      {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}

      {!detail ? (
        <div className="grid gap-3 md:grid-cols-2">{[0, 1].map((i) => <SkeletonCard key={i} />)}</div>
      ) : (
        <>
          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{detail.person.displayName}</h2>
              {detail.person.crossSystem ? (() => {
                const moved = detail.person.sources.some((s) => s.status === "PRIOR");
                const cls = moved
                  ? "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300"
                  : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300";
                return (
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${cls}`}>
                    {moved ? "Moved" : "Duplicate"} — {detail.person.sources.length} systems
                  </span>
                );
              })() : null}
            </div>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              National ID {detail.person.nationalId ?? "—"} · DOB {detail.person.dateOfBirth ?? "—"}
            </p>
          </div>

          {detail.timeline.move ? (
            <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
              History continues from <strong>{detail.timeline.move.fromTenantName}</strong> →{" "}
              <strong>{detail.timeline.move.toTenantName}</strong>
              {detail.timeline.move.date ? <> as of {fmtDay(detail.timeline.move.date)}</> : null}. Compliance history
              below is the union across both systems.
            </div>
          ) : null}

          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Linked systems</p>
            <ul className="space-y-1 text-sm">
              {detail.person.sources.map((s) => (
                // Composite key: with multi-tenant data the same externalId can appear across
                // systems, so externalId alone doesn't dedupe — tenantId + externalId does (matches
                // the merge-picker's key below and /people's source-badge list).
                <li key={`${s.tenantId}|${s.externalId}`} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">{s.tenantName}</span>
                  <span className="text-neutral-500 dark:text-neutral-400">{s.role} · {s.site} · {s.externalId}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${s.status === "ACTIVE" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" : "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"}`}>
                    {s.status}{s.status === "PRIOR" && s.moveDate ? ` · moved ${fmtDay(s.moveDate)}` : ""}
                  </span>
                  {mayReconcile && detail.person.sources.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => void unlink(s)}
                      disabled={busy}
                      className="rounded border border-rose-300 dark:border-rose-800 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-40"
                    >
                      Not this person — unlink
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {mayReconcile ? (
              <div className="mt-3 border-t border-neutral-100 dark:border-neutral-800 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    Reconcile: unlink a record that isn&apos;t this person, or link one that is. Every change is audited.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setMergeOpen((v) => !v);
                      setMergeQuery("");
                      setMergeResults([]);
                    }}
                    className="shrink-0 rounded border border-primary-300 dark:border-primary-800 px-2 py-1 text-xs font-medium text-primary-700 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-950/40"
                  >
                    {mergeOpen ? "Cancel" : "Link another record"}
                  </button>
                </div>
                {mergeOpen ? (
                  <div className="mt-2 rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/40 p-3">
                    <input
                      type="search"
                      autoFocus
                      value={mergeQuery}
                      onChange={(e) => {
                        setMergeQuery(e.target.value);
                        // Clear on EVERY change so stale candidates from the previous query can't be
                        // clicked (CONFIRM_LINK'd) under a new query; the debounced effect refetches.
                        setMergeResults([]);
                      }}
                      placeholder="Search by name, employee id, or national id…"
                      aria-label="Search for a record to link"
                      className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
                    />
                    <ul className="mt-2 space-y-1">
                      {mergeResults
                        .flatMap((p) => p.sources.map((s) => ({ ...s, personId: p.personId })))
                        .filter((s) => !ownRefs.has(`${s.tenantId}|${s.externalId}`))
                        .slice(0, 12)
                        .map((s) => (
                          <li key={`${s.tenantId}|${s.externalId}`} className="flex items-center justify-between gap-2 text-sm">
                            <span>
                              <span className="font-medium text-neutral-900 dark:text-neutral-100">{s.name}</span>{" "}
                              <span className="text-neutral-500 dark:text-neutral-400">{s.tenantName} · {s.externalId}</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => void confirmLink(s)}
                              disabled={busy}
                              className="shrink-0 rounded border border-emerald-300 dark:border-emerald-800 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 disabled:opacity-40"
                            >
                              Same person — link
                            </button>
                          </li>
                        ))}
                      {mergeQuery.trim().length >= 2 && mergeResults.length === 0 ? (
                        <li className="text-xs text-neutral-500 dark:text-neutral-400">No matching records.</li>
                      ) : null}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Compliance history (all systems)</p>
            {detail.timeline.entries.length === 0 ? (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">No recorded outcomes yet across the linked systems.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                    <tr className="border-b border-neutral-200 dark:border-neutral-800">
                      <th scope="col" className="px-3 py-2">Date</th>
                      <th scope="col" className="px-3 py-2">Measure</th>
                      <th scope="col" className="px-3 py-2">Status</th>
                      <th scope="col" className="px-3 py-2">System</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.timeline.entries.map((e, i) => (
                      <tr key={`${e.externalId}-${e.measureId}-${e.evaluatedAt}-${i}`} className="border-b border-neutral-100 dark:border-neutral-800/60">
                        <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">{fmt(e.evaluatedAt)}</td>
                        <td className="px-3 py-2">{e.measureName ?? e.measureId}</td>
                        <td className="px-3 py-2"><OutcomeChip status={e.status} /></td>
                        <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                          {e.tenantName}
                          {e.sourceStatus === "PRIOR" ? <span className="text-neutral-400"> (prior)</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
