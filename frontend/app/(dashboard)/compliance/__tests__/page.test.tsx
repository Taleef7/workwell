import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getWithHeaders = vi.fn();
const post = vi.fn();
// The page calls the token-bound useApi() hook (mirrors cases/page.tsx). The real hook returns a
// MEMOIZED (stable) client; mirror that here with a single stable object so the page's effect deps
// don't see a new reference every render (which would refetch on every render).
const apiMock = { getWithHeaders, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const startTracking = vi.fn();
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: false, startTracking }) }));

vi.mock("@/lib/rbac", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac")>();
  return { ...actual };
});
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));

import CompliancePage from "../page";

const rosterImmun = {
  data: {
    panel: "immunizations",
    columns: [
      { measureId: "mmr", name: "MMR", complianceClass: "PERMANENT" },
      { measureId: "varicella", name: "Varicella", complianceClass: "PERMANENT" }
    ],
    rows: [
      {
        subject: { externalId: "emp-001", name: "Ada Lovelace", role: "Nurse", site: "HQ" },
        cells: {
          mmr: { status: "COMPLIANT", method: "2 valid dose(s)" },
          varicella: { status: "IN_PROGRESS", method: "1 of 2 doses on file" }
        }
      }
    ]
  },
  headers: new Headers({ "X-Total-Count": "1" })
};

beforeEach(() => {
  getWithHeaders.mockReset().mockResolvedValue(rosterImmun);
  post.mockReset().mockResolvedValue({ runId: "run-9", status: "REQUESTED" });
  startTracking.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("CompliancePage", () => {
  it("renders the panel's columns and a chip per cell", async () => {
    render(<CompliancePage />);
    expect(await screen.findByText("Individual Compliance Status")).toBeInTheDocument();
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalled());
    expect(screen.getByRole("columnheader", { name: /MMR/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Varicella/ })).toBeInTheDocument();
    const row = screen.getByText("Ada Lovelace").closest("tr")!;
    expect(within(row).getByText("Compliant")).toBeInTheDocument();
    expect(within(row).getByText("In Progress")).toBeInTheDocument();
    expect(within(row).getByText("1 of 2 doses on file")).toBeInTheDocument();
  });

  it("refetches when the panel changes", async () => {
    render(<CompliancePage />);
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalledTimes(1));
    await userEvent.selectOptions(screen.getByLabelText(/Panel/i), "osha");
    await waitFor(() => {
      const lastUrl = String(getWithHeaders.mock.calls.at(-1)?.[0] ?? "");
      expect(lastUrl).toContain("panel=osha");
    });
  });

  it("Recalculate triggers an ALL_PROGRAMS run and tracks it", async () => {
    render(<CompliancePage />);
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /Recalculate/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/runs/manual", { scopeType: "ALL_PROGRAMS" }));
    expect(startTracking).toHaveBeenCalledWith("run-9", "REQUESTED");
  });

  it("shows an error alert when the roster fetch fails", async () => {
    getWithHeaders.mockReset().mockRejectedValue(new Error("boom"));
    render(<CompliancePage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("boom");
  });

  it("shows an empty-state row when no employees match", async () => {
    getWithHeaders.mockReset().mockResolvedValue({
      data: { panel: "immunizations", columns: rosterImmun.data.columns, rows: [] },
      headers: new Headers({ "X-Total-Count": "0" })
    });
    render(<CompliancePage />);
    expect(await screen.findByText("No employees match these filters.")).toBeInTheDocument();
  });
});
