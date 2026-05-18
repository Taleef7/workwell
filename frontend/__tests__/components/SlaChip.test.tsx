import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SlaChip } from "@/components/SlaChip";

describe("SlaChip", () => {
  it("renders null when slaRemainingDays is null", () => {
    const { container } = render(<SlaChip slaRemainingDays={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders null when slaRemainingDays is undefined", () => {
    const { container } = render(<SlaChip slaRemainingDays={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders 'Breached' when slaBreached is true", () => {
    render(<SlaChip slaRemainingDays={-3} slaBreached />);
    expect(screen.getByTestId("sla-chip")).toHaveTextContent("Breached");
  });

  it("applies red class when slaBreached is true", () => {
    render(<SlaChip slaRemainingDays={5} slaBreached />);
    expect(screen.getByTestId("sla-chip")).toHaveClass("text-red-700");
  });

  it("renders day count when not breached", () => {
    render(<SlaChip slaRemainingDays={5} />);
    expect(screen.getByTestId("sla-chip")).toHaveTextContent("5d");
  });

  it("applies yellow class when slaRemainingDays is 5 (≤7)", () => {
    render(<SlaChip slaRemainingDays={5} />);
    expect(screen.getByTestId("sla-chip")).toHaveClass("text-yellow-600");
  });

  it("applies red class when slaRemainingDays is ≤2", () => {
    render(<SlaChip slaRemainingDays={2} />);
    expect(screen.getByTestId("sla-chip")).toHaveClass("text-red-600");
  });

  it("applies slate class when slaRemainingDays is ≥8", () => {
    render(<SlaChip slaRemainingDays={10} />);
    expect(screen.getByTestId("sla-chip")).toHaveClass("text-slate-500");
  });
});
