/**
 * Unit tests for ChartDataTable — the screen-reader-only accessible alternative
 * rendered alongside each (aria-hidden) Recharts chart. Contracts:
 *  1. Renders a real <table> whose accessible name is the caption.
 *  2. Column headers are <th scope="col">.
 *  3. Every row/cell value is present in the accessibility tree.
 *  4. Carries the `sr-only` class so it is visually hidden but readable by AT.
 *  5. Empty data renders the empty label and no column headers.
 *  6. Nullish cells render an em dash rather than blank.
 */

import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ChartDataTable } from "../chart-data-table";

describe("ChartDataTable", () => {
  it("renders a table named by its caption", () => {
    render(
      <ChartDataTable
        caption="Audiogram compliance trend"
        columns={["Run date", "Compliance"]}
        rows={[["May 1", "82%"]]}
      />
    );
    expect(screen.getByRole("table", { name: "Audiogram compliance trend" })).toBeInTheDocument();
  });

  it("renders scoped column headers", () => {
    render(
      <ChartDataTable
        caption="Outcome breakdown"
        columns={["Outcome", "Count"]}
        rows={[["Compliant", 12]]}
      />
    );
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(["Outcome", "Count"]);
    headers.forEach((h) => expect(h).toHaveAttribute("scope", "col"));
  });

  it("renders every row and cell value", () => {
    render(
      <ChartDataTable
        caption="Compliance trend"
        columns={["Date", "Compliance"]}
        rows={[
          ["May 1", "80%"],
          ["May 8", "84%"],
        ]}
      />
    );
    const table = screen.getByRole("table");
    // Header row + 2 data rows.
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("May 8")).toBeInTheDocument();
    expect(within(table).getByText("84%")).toBeInTheDocument();
  });

  it("is visually hidden via the sr-only class", () => {
    render(<ChartDataTable caption="c" columns={["A"]} rows={[["x"]]} />);
    expect(screen.getByRole("table")).toHaveClass("sr-only");
  });

  it("renders an empty label and no column headers when there are no rows", () => {
    render(
      <ChartDataTable
        caption="Empty trend"
        columns={["Date", "Compliance"]}
        rows={[]}
        emptyLabel="No run history"
      />
    );
    expect(screen.getByText("No run history")).toBeInTheDocument();
    expect(screen.queryAllByRole("columnheader")).toHaveLength(0);
  });

  it("renders an em dash for nullish cells", () => {
    render(
      <ChartDataTable
        caption="Trend"
        columns={["Date", "Compliance"]}
        rows={[["May 1", null]]}
      />
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
