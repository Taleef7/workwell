import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CopyableId } from "./copyable-id";

describe("CopyableId", () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("shortens a long id but keeps the full value in the title", () => {
    render(<CopyableId id="d314bc1c-9f71-40fe-a543-0123456789ab" />);
    const token = screen.getByText("d314bc1c…");
    expect(token).toBeInTheDocument();
    expect(token).toHaveAttribute("title", "d314bc1c-9f71-40fe-a543-0123456789ab");
  });

  it("renders a link to the id's surface when href is given", () => {
    render(<CopyableId id="run-123456789012" href="/runs?runId=run-123456789012" label="run id" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/runs?runId=run-123456789012");
  });

  it("copies the full id to the clipboard on click", async () => {
    render(<CopyableId id="abcdefghijklmnop" label="run id" />);
    fireEvent.click(screen.getByLabelText("Copy run id"));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("abcdefghijklmnop"));
  });

  it("renders a dash for an empty id", () => {
    render(<CopyableId id="" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
