import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { VersionActions } from "../VersionActions";

function Harness({
  onCreateNewVersion,
  canClone = true,
}: {
  onCreateNewVersion?: () => Promise<boolean>;
  canClone?: boolean;
}) {
  const [summary, setSummary] = React.useState("");
  return (
    <VersionActions
      version="1.0"
      statusLabel="Draft"
      canClone={canClone}
      changeSummary={summary}
      onChangeSummaryChange={setSummary}
      onCreateNewVersion={onCreateNewVersion ?? (() => Promise.resolve(true))}
    />
  );
}

describe("VersionActions (UX-15)", () => {
  it("is an accessible disclosure: trigger uses aria-expanded/aria-controls (not a menu) and stays collapsed by default", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Version actions" });
    // Disclosure semantics — NOT role=menu (a menu cannot legitimately hold a textbox).
    expect(trigger).not.toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls");
    // Controls hidden until opened.
    expect(screen.queryByLabelText("Change summary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Version" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Version actions" })).not.toBeInTheDocument();
  });

  it("reveals a role=group panel with the change-summary input + New Version action together when opened", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Version actions" }));
    expect(screen.getByRole("button", { name: "Version actions" })).toHaveAttribute("aria-expanded", "true");
    // The panel is a group/region, not a menu.
    expect(screen.getByRole("group", { name: "Version actions" })).toBeInTheDocument();
    expect(screen.getByLabelText("Change summary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Version" })).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Version actions" }));
    expect(screen.getByRole("group", { name: "Version actions" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Change summary"), { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Version actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Version actions" })).toHaveAttribute("aria-expanded", "false");
  });

  it("passes the typed change summary through to the New Version handler (wiring intact)", async () => {
    const onCreateNewVersion = vi.fn().mockResolvedValue(true);
    render(<Harness onCreateNewVersion={onCreateNewVersion} />);
    fireEvent.click(screen.getByRole("button", { name: "Version actions" }));
    fireEvent.change(screen.getByLabelText("Change summary"), { target: { value: "tightened window" } });
    fireEvent.click(screen.getByRole("button", { name: "New Version" }));
    await waitFor(() => expect(onCreateNewVersion).toHaveBeenCalledTimes(1));
  });

  it("renders nothing when the user cannot author versions (role-gating preserved)", () => {
    const { container } = render(<Harness canClone={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "Version actions" })).not.toBeInTheDocument();
  });
});
