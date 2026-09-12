"use client";

/**
 * Panels — who works which provider's patients (MM-2 PR 2, ADR-080).
 *
 * The pilot group's staff are already assigned to specific providers; this is where that arrangement
 * gets written down, so the cases a nightly run opens arrive on somebody instead of in a pile.
 *
 * **Unmapped providers sort first and are never hidden.** A provider nobody owns is the row a
 * supervisor needs to see, and a screen that lists only the covered panels would make the gap
 * invisible on exactly the page meant to reveal it. Same reasoning as a queue chip that renders at
 * zero rather than disappearing.
 */
import { useState } from "react";
import { Badge, Button, Select } from "@mieweb/ui";
import { emitToast } from "@/lib/toast";
import { SUBJECT } from "@/lib/terminology";
import { providerFilterLabel } from "./use-panel-providers";
import { UNASSIGN_VALUE } from "./use-assignable-users";
import type { PanelRow, PanelSaveResult } from "./use-panel-assignments";

/**
 * The panel state is OWNED BY THE PAGE and passed in, rather than mounted again here.
 *
 * Two copies of the hook meant two `GET /api/panels` on every visit, and — the part that mattered —
 * a save inside this tab refreshed only this copy. The page's own `myPanels` stayed stale, so after
 * mapping a panel to yourself the "My panel" chip still said none were yours: a label describing a
 * different set than the list beside it.
 */
export function PanelsTab({
  rows,
  loading,
  error,
  canManage,
  assignableOptions,
  canonicalFor,
  onSave,
  onRemove,
}: {
  rows: PanelRow[];
  loading: boolean;
  error: string | null;
  canManage: boolean;
  assignableOptions: { value: string; label: string }[];
  canonicalFor: (email: string) => string | undefined;
  onSave: (providerId: string, assignee: string) => Promise<PanelSaveResult>;
  onRemove: (providerId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function assign(row: PanelRow, value: string) {
    if (!value || busy) return;
    setBusy(row.providerId);
    try {
      const result = await onSave(row.providerId, value);
      // The toast reports what MOVED, not what was asked for — the same rule the bulk assign follows.
      // "Saved" over a mapping that quietly reassigned 212 open cases tells the operator nothing about
      // the part that matters.
      const moved =
        result.backfilled > 0
          ? `${result.backfilled} open ${result.backfilled === 1 ? "gap" : "gaps"} moved`
          : "no open gaps to move";
      const mapping = result.changed ? `${row.providerName} → ${result.assignee}` : `${row.providerName} unchanged`;
      emitToast(`${mapping}; ${moved}.`, "success");
    } catch (err) {
      emitToast(err instanceof Error ? err.message : "Could not save the panel", "error");
    } finally {
      setBusy(null);
    }
  }

  async function unmap(row: PanelRow) {
    setBusy(row.providerId);
    try {
      await onRemove(row.providerId);
      // Said explicitly, because it is the surprising half: un-mapping decides who owns FUTURE work
      // and deliberately leaves cases somebody is already working where they are (ADR-080 d4).
      emitToast(`${row.providerName} is unassigned. Open gaps keep their current owner.`, "success");
    } catch (err) {
      emitToast(err instanceof Error ? err.message : "Could not unassign the panel", "error");
    } finally {
      setBusy(null);
    }
  }

  if (loading && rows.length === 0) {
    return <p className="p-4 text-sm text-neutral-600 dark:text-neutral-400">Loading panels…</p>;
  }
  if (error) {
    return <p className="p-4 text-sm text-red-600 dark:text-red-400">Panels could not be loaded: {error}</p>;
  }

  const unmapped = rows.filter((r) => !r.assignee).length;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Who works each {providerFilterLabel().toLowerCase()}&apos;s {SUBJECT.plural}. New gaps open on the
        panel&apos;s owner, and changing an owner moves that panel&apos;s open gaps with it — except any a
        person assigned by hand, which stay put.{" "}
        {unmapped > 0 ? (
          <span className="font-medium text-amber-700 dark:text-amber-400">
            {unmapped} {unmapped === 1 ? "panel has" : "panels have"} no owner.
          </span>
        ) : null}
      </p>

      <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">{providerFilterLabel()}</th>
              <th scope="col" className="px-3 py-2 font-medium">Location</th>
              <th scope="col" className="px-3 py-2 font-medium">{SUBJECT.Plural}</th>
              <th scope="col" className="px-3 py-2 font-medium">Worked by</th>
              {canManage ? <th scope="col" className="px-3 py-2 font-medium sr-only">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.providerId}
                className="border-t border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
              >
                <td className="px-3 py-2 font-medium text-neutral-900 dark:text-neutral-100">{row.providerName}</td>
                <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">{row.location}</td>
                <td className="px-3 py-2 tabular-nums text-neutral-600 dark:text-neutral-400">
                  {row.patients.toLocaleString()}
                </td>
                <td className="px-3 py-2">
                  {canManage ? (
                    <Select
                      size="sm"
                      className="w-64"
                      aria-label={`Worked by, ${row.providerName}`}
                      disabled={busy === row.providerId}
                      value={row.assignee ? (canonicalFor(row.assignee) ?? row.assignee) : ""}
                      onValueChange={(value) => void assign(row, value)}
                      options={[
                        // A placeholder, never a verb. An earlier version offered "Nobody —
                        // unassigned" here, which `assign` then discarded as an empty value: a control
                        // that looked like it did something and did nothing. Un-mapping is the button
                        // beside it, and one action gets one spelling.
                        { value: "", label: "Choose who works this panel…" },
                        // `UNASSIGN_VALUE` by name, not by literal: it happens to be "__unassigned__"
                        // today, and a filter that silently stops matching if the constant moves is
                        // the guard-that-cannot-fire shape this project collects.
                        ...assignableOptions.filter((o) => o.value !== "" && o.value !== UNASSIGN_VALUE),
                        // A stored owner the deployment no longer offers still renders as itself,
                        // rather than leaving the control blank over a panel that HAS an owner.
                        ...(row.assignee && !canonicalFor(row.assignee)
                          ? [{ value: row.assignee, label: `${row.assignee} — no longer assignable` }]
                          : []),
                      ]}
                    />
                  ) : row.assignee ? (
                    <span className="text-neutral-700 dark:text-neutral-300">{row.assignee}</span>
                  ) : (
                    <Badge variant="warning">Unassigned</Badge>
                  )}
                </td>
                {canManage ? (
                  <td className="px-3 py-2 text-right">
                    {row.assignee ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === row.providerId}
                        onClick={() => void unmap(row)}
                      >
                        Unassign
                      </Button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
