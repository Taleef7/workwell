"use client";

import { useState } from "react";
import { Button, Dropdown, DropdownContent, Input } from "@mieweb/ui";

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
   * success so the menu can close. Validation ("required") lives in the handler —
   * this component does not re-implement it.
   */
  onCreateNewVersion: () => Promise<boolean>;
}

/**
 * UX-15: groups the Studio version actions (current version + status, the
 * "Change summary (required)" input, and the "New Version" clone action) into a
 * single labelled "Version actions" dropdown menu, so authors read them as one
 * unit next to the tab content instead of finding them scattered in the header.
 *
 * Layout/grouping only — all versioning behaviour, validation, and role-gating are
 * preserved: the change-summary value still feeds `onCreateNewVersion`, and the
 * menu is entirely omitted for users who cannot author versions. The `@mieweb/ui`
 * `Dropdown` supplies the accessible disclosure contract (button toggle,
 * `aria-haspopup`/`aria-expanded`/`aria-controls`, Escape + outside-click close).
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

  if (!canClone) return null;

  async function handleCreate() {
    const ok = await onCreateNewVersion();
    if (ok) setOpen(false);
  }

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      placement="bottom-end"
      width={320}
      trigger={
        <Button type="button" variant="outline" size="sm" aria-label="Version actions">
          Version actions
        </Button>
      }
    >
      <DropdownContent className="space-y-3 p-3">
        {version ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Current version{" "}
            <span className="font-medium text-neutral-800 dark:text-neutral-200">{version}</span>
            {statusLabel ? <> • {statusLabel}</> : null}
          </p>
        ) : null}
        <Input
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
      </DropdownContent>
    </Dropdown>
  );
}
