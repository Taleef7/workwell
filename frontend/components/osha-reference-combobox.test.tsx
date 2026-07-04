import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OshaReferenceCombobox, type OshaReferenceOption } from "./osha-reference-combobox";

const REFS: OshaReferenceOption[] = [
  { id: "r1", cfrCitation: "1910.95", title: "Occupational Noise Exposure", programArea: "Hearing" },
  { id: "r2", cfrCitation: "1910.120", title: "HAZWOPER", programArea: "Hazmat" },
  { id: "r3", cfrCitation: "1910.134", title: "Respiratory Protection", programArea: "Respiratory" }
];

function setup(overrides: Partial<React.ComponentProps<typeof OshaReferenceCombobox>> = {}) {
  const onValueChange = vi.fn();
  const onReferenceSelect = vi.fn();
  const utils = render(
    <OshaReferenceCombobox
      value=""
      selectedReferenceId={null}
      references={REFS}
      onValueChange={onValueChange}
      onReferenceSelect={onReferenceSelect}
      {...overrides}
    />
  );
  return { onValueChange, onReferenceSelect, ...utils };
}

describe("OshaReferenceCombobox", () => {
  it("exposes the ARIA combobox roles", () => {
    setup();
    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveAttribute("aria-controls");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
  });

  it("opens the listbox on focus and marks it expanded", () => {
    setup();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("selects an option with the keyboard (ArrowDown + Enter)", async () => {
    const user = userEvent.setup();
    const { onValueChange, onReferenceSelect } = setup();
    const input = screen.getByRole("combobox");
    input.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onReferenceSelect).toHaveBeenCalledWith(REFS[0]);
    expect(onValueChange).toHaveBeenCalledWith("1910.95 — Occupational Noise Exposure");
    // list closes after selection
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("tracks the active option via aria-activedescendant", async () => {
    const user = userEvent.setup();
    setup();
    const input = screen.getByRole("combobox");
    input.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const activeId = input.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    const secondOption = screen.getAllByRole("option")[1];
    expect(secondOption.id).toBe(activeId);
    expect(secondOption).toHaveAttribute("aria-selected", "true");
  });

  it("closes the listbox on Escape", async () => {
    const user = userEvent.setup();
    setup();
    const input = screen.getByRole("combobox");
    await user.click(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("still selects an option on mouse click", async () => {
    const { onReferenceSelect } = setup();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.click(screen.getByRole("option", { name: /1910\.120/ }));
    expect(onReferenceSelect).toHaveBeenCalledWith(REFS[1]);
  });

  it("filters options by the typed query", () => {
    setup({ value: "respir" });
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("1910.134");
  });
});
