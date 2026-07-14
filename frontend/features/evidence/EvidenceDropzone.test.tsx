import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EvidenceDropzone } from "./EvidenceDropzone";

function makeFile(name: string, size: number): File {
  const file = new File(["x".repeat(size)], name, { type: "application/pdf" });
  // jsdom does not set size from content reliably across versions; force it.
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("EvidenceDropzone", () => {
  it("renders the accessible file input", () => {
    render(<EvidenceDropzone file={null} onFileChange={() => {}} />);
    expect(screen.getByLabelText("Evidence file")).toBeInTheDocument();
  });

  it("calls onFileChange when a file is selected via the input", () => {
    const onFileChange = vi.fn();
    render(<EvidenceDropzone file={null} onFileChange={onFileChange} />);
    const input = screen.getByLabelText("Evidence file") as HTMLInputElement;
    const file = makeFile("report.pdf", 2048);
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFileChange).toHaveBeenCalledWith(file);
  });

  it("shows the selected file name and size", () => {
    render(<EvidenceDropzone file={makeFile("audiogram.pdf", 2048)} onFileChange={() => {}} />);
    expect(screen.getByText(/audiogram\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/2 KB/)).toBeInTheDocument();
  });

  it("calls onFileChange with the dropped file on a drop event", () => {
    const onFileChange = vi.fn();
    render(<EvidenceDropzone file={null} onFileChange={onFileChange} />);
    const dropped = makeFile("dropped.png", 1024);
    const zone = screen.getByTestId("evidence-dropzone");
    fireEvent.drop(zone, { dataTransfer: { files: [dropped] } });
    expect(onFileChange).toHaveBeenCalledWith(dropped);
  });

  it("renders the synthetic-evidence demo note", () => {
    render(<EvidenceDropzone file={null} onFileChange={() => {}} />);
    expect(
      screen.getByText(/synthetic demo evidence/i)
    ).toBeInTheDocument();
  });
});
