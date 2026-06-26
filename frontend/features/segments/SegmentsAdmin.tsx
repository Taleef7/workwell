"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@mieweb/ui";
import { useAuth } from "@/components/auth-provider";
import { useApi } from "@/lib/api/hooks";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { normalizeEnumValue } from "@/lib/status";
import { canManageSegments } from "@/lib/rbac";
import { useSegments } from "./hooks/useSegments";
import { SegmentsList } from "./SegmentsList";
import { SegmentEditorModal } from "./SegmentEditorModal";
import type { Segment, SegmentDraft } from "./types";

type MeasureOption = { id: string; name: string; status: string };

/** Orchestrates the Configure Groups admin surface: list + create/edit/delete + live member counts. */
export function SegmentsAdmin() {
  const { user } = useAuth();
  const canManage = canManageSegments(user?.role);
  const api = useApi();
  const { segments, loading, error, refetch, create, update, remove } = useSegments();

  const [measures, setMeasures] = useState<{ id: string; name: string }[]>([]);
  const [measureNames, setMeasureNames] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<Segment | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Segment | null>(null);

  // Load the measure catalog: Active measures power the editor's checkboxes; the full list names a
  // measure in the table even if it was later deprecated.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      void api
        .get<MeasureOption[]>("/api/measures")
        .then((rows) => {
          if (cancelled) return;
          setMeasures(
            rows
              .filter((m) => normalizeEnumValue(m.status) === "ACTIVE")
              .map((m) => ({ id: m.id, name: m.name }))
          );
          setMeasureNames(Object.fromEntries(rows.map((m) => [m.id, m.name])));
        })
        .catch(() => {
          if (!cancelled) {
            setMeasures([]);
            setMeasureNames({});
          }
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [api]);

  // Live membership counts: one preview call per segment (cohort scale is tiny). Cancel-flag guards
  // against a stale segments list resolving after a newer one.
  const recomputeCounts = useCallback(
    (list: Segment[]) => {
      let cancelled = false;
      list.forEach((s) => {
        void api
          .post<{ rule: Segment["rule"]; overrides: Segment["overrides"] }, { count: number; members: string[] }>(
            "/api/segments/preview",
            { rule: s.rule, overrides: s.overrides }
          )
          .then((r) => {
            if (!cancelled) setCounts((prev) => ({ ...prev, [s.id]: r.count }));
          })
          .catch(() => {
            /* leave the count as "—" on failure */
          });
      });
      return () => {
        cancelled = true;
      };
    },
    [api]
  );

  useEffect(() => {
    const cancel = recomputeCounts(segments);
    return cancel;
  }, [segments, recomputeCounts]);

  const handleSave = useCallback(
    (draft: SegmentDraft) => (editing ? update(editing.id, draft) : create(draft)),
    [editing, create, update]
  );

  const confirmDelete = useCallback(async () => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    try {
      await remove(target.id);
      await refetch();
    } catch {
      /* surfaced via the list error path on next load; keep the UI responsive */
    }
  }, [pendingDelete, remove, refetch]);

  return (
    <article className="rounded-3xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">risk groups</p>
          <h3 className="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Configure groups</h3>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            A group maps a cohort (role / site rule + per-employee include/exclude overrides) to the measures that
            apply to it. Applicability gates roster display and case creation only — never compliance.
          </p>
        </div>
        {canManage ? (
          <Button type="button" variant="primary" size="sm" onClick={() => setCreating(true)}>
            New group
          </Button>
        ) : null}
      </div>

      {error ? <p className="mt-4 text-sm text-red-700">Error: {error}</p> : null}
      {loading ? <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">Loading groups…</p> : null}

      <div className="mt-4">
        <SegmentsList
          segments={segments}
          counts={counts}
          measureNames={measureNames}
          onEdit={(s) => setEditing(s)}
          onDelete={(s) => setPendingDelete(s)}
          canManage={canManage}
        />
      </div>

      {canManage ? (
        <SegmentEditorModal
          open={creating || !!editing}
          initial={editing}
          activeMeasures={measures}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            void refetch();
          }}
          onSave={handleSave}
        />
      ) : null}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete group"
        description={pendingDelete ? `Delete "${pendingDelete.name}"? This cannot be undone.` : ""}
        confirmLabel="Delete"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </article>
  );
}
