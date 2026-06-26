"use client";

import { Button } from "@mieweb/ui";
import type { Segment } from "./types";

type Props = {
  segments: Segment[];
  counts: Record<string, number>;
  measureNames: Record<string, string>;
  onEdit: (s: Segment) => void;
  onDelete: (s: Segment) => void;
  canManage: boolean;
  loading?: boolean;
};

/** Presentational table of configured risk-group segments. Parent owns all state + delete confirm. */
export function SegmentsList({ segments, counts, measureNames, onEdit, onDelete, canManage, loading = false }: Props) {
  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-neutral-50 dark:bg-neutral-800/50">
          <tr>
            <th scope="col" className="px-4 py-2 font-semibold text-neutral-700 dark:text-neutral-300">Name</th>
            <th scope="col" className="px-4 py-2 font-semibold text-neutral-700 dark:text-neutral-300">Enabled</th>
            <th scope="col" className="px-4 py-2 font-semibold text-neutral-700 dark:text-neutral-300">Members</th>
            <th scope="col" className="px-4 py-2 font-semibold text-neutral-700 dark:text-neutral-300">Applicable measures</th>
            {canManage ? (
              <th scope="col" className="px-4 py-2 text-right font-semibold text-neutral-700 dark:text-neutral-300">Actions</th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {segments.length === 0 && !loading ? (
            <tr>
              <td colSpan={canManage ? 5 : 4} className="px-4 py-6 text-center text-neutral-500 dark:text-neutral-400">
                No groups configured.
              </td>
            </tr>
          ) : null}
          {segments.map((s) => (
            <tr key={s.id} className="border-t border-neutral-100 dark:border-neutral-800/60 align-top">
              <td className="px-4 py-3">
                <p className="font-medium text-neutral-900 dark:text-neutral-100">{s.name}</p>
                {s.description ? (
                  <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{s.description}</p>
                ) : null}
              </td>
              <td className="px-4 py-3">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    s.enabled
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
                >
                  {s.enabled ? "Enabled" : "Disabled"}
                </span>
              </td>
              <td className="px-4 py-3 text-neutral-700 dark:text-neutral-300">{counts[s.id] ?? "—"}</td>
              <td className="px-4 py-3 text-neutral-700 dark:text-neutral-300">
                {s.measureIds.length > 0
                  ? s.measureIds.map((id) => measureNames[id] ?? id).join(", ")
                  : "—"}
              </td>
              {canManage ? (
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => onEdit(s)}>
                      Edit
                    </Button>
                    <Button type="button" variant="danger" size="sm" onClick={() => onDelete(s)}>
                      Delete
                    </Button>
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
