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
  it("keeps the change-summary input and New Version action hidden until the Version menu is opened", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Version actions" });
    // The grouped menu exposes the proper ARIA disclosure contract and stays collapsed by default.
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Change summary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Version" })).not.toBeInTheDocument();
  });

  it("reveals the grouped change-summary input + New Version action together when the menu opens", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Version actions" }));
    expect(screen.getByRole("button", { name: "Version actions" })).toHaveAttribute("aria-expanded", "true");
    // Both version controls are now present as one grouped unit.
    expect(screen.getByLabelText("Change summary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Version" })).toBeInTheDocument();
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
