"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
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

export default function PersonDetailPage() {
  const params = useParams<{ personId: string }>();
  const personId = params.personId;
  const api = useApi();
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

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
              {detail.timeline.move.date ? <> as of {fmt(detail.timeline.move.date)}</> : null}. Compliance history
              below is the union across both systems.
            </div>
          ) : null}

          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Linked systems</p>
            <ul className="space-y-1 text-sm">
              {detail.person.sources.map((s) => (
                <li key={s.externalId} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">{s.tenantName}</span>
                  <span className="text-neutral-500 dark:text-neutral-400">{s.role} · {s.site} · {s.externalId}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${s.status === "ACTIVE" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" : "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"}`}>
                    {s.status}{s.status === "PRIOR" && s.moveDate ? ` · moved ${fmt(s.moveDate)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
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
