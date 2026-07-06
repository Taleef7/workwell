"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button, Input } from "@mieweb/ui";

export interface VersionActionsProps {
  /** Current measure version (e.g. "1.0"). */
  version?: string;
  /** Human-readable lifecycle status label (e.g. "Draft"). */
  statusLabel?: string;
  /** Whether the current user may author/clone versions (mirrors rbac `canAuthorMeasures`). */
  canClone: boolean;
  /** Controlled change-summary value (owned by the Studio page). */
  changeSummary: string;
  /** Change-summary change handler. */
  onChangeSummaryChange: (value: string) => void;
  /**
   * Creates a new draft version from the current change summary. Returns true on
   * success so the panel can close. Validation ("required") lives in the handler —
   * this component does not re-implement it.
   */
  onCreateNewVersion: () => Promise<boolean>;
}

/**
 * UX-15: groups the Studio version actions (current version + status, the
 * "Change summary (required)" input, and the "New Version" clone action) into a
 * single labelled "Version actions" control, so authors read them as one unit next
 * to the tab content instead of finding them scattered in the header.
 *
 * This is a proper **disclosure/popover** — deliberately NOT a `role="menu"`: a menu
 * must contain `menuitem` children, and this panel holds a free-text `Input`
 * (textbox) + a button. A textbox inside a menu is mis-announced by screen readers,
 * and this repo holds a strict WCAG 2.2 AA posture. So the trigger is a plain
 * `<button>` with `aria-expanded`/`aria-controls` (no `aria-haspopup="menu"`) and the
 * panel is a `role="group"` region. Open/close, Escape, outside-click, and focus
 * management are hand-rolled.
 *
 * Layout/grouping only — all versioning behaviour, validation, and role-gating are
 * preserved: the change-summary value still feeds `onCreateNewVersion`, and the
 * control is entirely omitted for users who cannot author versions.
 */
export function VersionActions({
  version,
  statusLabel,
  canClone,
  changeSummary,
  onChangeSummaryChange,
  onCreateNewVersion,
}: VersionActionsProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Move focus into the panel (the change-summary field) when it opens — standard
  // disclosure focus management.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Close on outside interaction (pointerdown fires before a focus change) while open.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  if (!canClone) return null;

  function closeAndRefocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      closeAndRefocus();
    }
  }

  async function handleCreate() {
    const ok = await onCreateNewVersion();
    if (ok) setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative inline-flex" onKeyDown={onKeyDown}>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        aria-label="Version actions"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
      >
        Version actions
      </Button>
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label="Version actions"
          className="absolute right-0 top-full z-50 mt-2 w-80 space-y-3 rounded-xl border border-neutral-200 bg-white p-3 shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
        >
          {version ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Current version{" "}
              <span className="font-medium text-neutral-800 dark:text-neutral-200">{version}</span>
              {statusLabel ? <> • {statusLabel}</> : null}
            </p>
          ) : null}
          <Input
            ref={inputRef}
            label="Change summary"
            hideLabel
            placeholder="Change summary (required)"
            value={changeSummary}
            onChange={(e) => onChangeSummaryChange(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => void handleCreate()}
          >
            New Version
          </Button>
        </div>
      ) : null}
    </div>
  );
}
