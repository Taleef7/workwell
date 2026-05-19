/**
 * Unit tests for ConfirmDialog accessibility/interaction contracts:
 *  1. Not rendered when closed; rendered as a modal alertdialog when open.
 *  2. Confirm / Cancel buttons invoke their callbacks.
 *  3. Escape and backdrop click cancel.
 *  4. Initial focus moves to the confirm button.
 *  5. Body scroll is locked while open and restored on close.
 *  6. Tab / Shift+Tab focus is trapped within the dialog.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfirmDialog } from "../confirm-dialog";

function setup(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ConfirmDialog
      open
      title="Run all active programs?"
      description="This evaluates every tracked employee."
      confirmLabel="Run all measures"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { onConfirm, onCancel, ...utils };
}

describe("ConfirmDialog", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
  });

  it("renders nothing when closed", () => {
    setup({ open: false });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("renders an accessible modal alertdialog when open", () => {
    setup();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Run all active programs?");
    expect(dialog).toHaveAccessibleDescription("This evaluates every tracked employee.");
  });

  it("invokes onConfirm when the confirm button is clicked", async () => {
    const { onConfirm, onCancel } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Run all measures" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("invokes onCancel when the cancel button is clicked", async () => {
    const { onCancel } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("invokes onCancel on Escape", () => {
    const { onCancel } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("invokes onCancel when the backdrop is clicked", async () => {
    const { onCancel } = setup();
    // The backdrop is the aria-hidden overlay sibling of the dialog.
    const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
    await userEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("moves initial focus to the confirm button", () => {
    setup();
    expect(screen.getByRole("button", { name: "Run all measures" })).toHaveFocus();
  });

  it("locks body scroll while open and restores it on close", () => {
    const { rerender } = setup();
    expect(document.body.style.overflow).toBe("hidden");
    rerender(
      <ConfirmDialog
        open={false}
        title="t"
        description="d"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(document.body.style.overflow).toBe("");
  });

  it("traps Tab focus within the dialog", () => {
    setup();
    const confirm = screen.getByRole("button", { name: "Run all measures" });
    const cancel = screen.getByRole("button", { name: "Cancel" });

    confirm.focus();
    // Tab from the last focusable wraps back to the first.
    fireEvent.keyDown(document, { key: "Tab" });
    expect(cancel).toHaveFocus();

    // Shift+Tab from the first focusable wraps to the last.
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
  });
});
