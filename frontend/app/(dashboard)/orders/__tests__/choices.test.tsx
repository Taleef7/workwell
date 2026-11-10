import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrdersPage from "../page";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const role = { current: "ROLE_QUALITY_STAFF" };
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: role.current, email: "x@example.com" } }),
}));

const CPT = "http://www.ama-assn.org/go/cpt";
const opt = (code: string, display: string, approved: boolean) => ({ key: `${CPT}|${code}`, code, system: CPT, display, suggestible: true, approved });

describe("OrdersPage: the clinician chooses (#640)", () => {
  beforeEach(() => {
    role.current = "ROLE_QUALITY_STAFF";
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") return Promise.resolve([{ id: "cms130", name: "Colorectal Cancer Screening", status: "Active" }]);
      if (url.startsWith("/api/orders/proposals?")) {
        return Promise.resolve({
          proposed: [],
          suppressed: [],
          choices: [{ subjectId: "pat-001", measureId: "cms130", reasonOutcome: "OVERDUE", priority: "urgent", optionKeys: [`${CPT}|82274`, `${CPT}|45378`] }],
          totals: { proposed: 0, suppressed: 0, choices: 1 },
          ordersByMeasure: {
            cms130: { mode: "choice", options: [opt("45378", "Colonoscopy", false), opt("82274", "Fecal immunochemical test (FIT)", true), opt("81528", "FIT-DNA", false)] },
          },
          measuresWithoutOrder: [],
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  });

  it("lists a choice row's open options with their card state, and no default", async () => {
    render(<OrdersPage />);
    const section = await screen.findByTestId("clinician-chooses");
    expect(within(section).getByText("Clinician chooses (1)")).toBeInTheDocument();
    expect(within(section).getByText("Fecal immunochemical test (FIT)")).toBeInTheDocument();
    expect(within(section).getByText("Colonoscopy")).toBeInTheDocument();
    expect(within(section).queryByText("FIT-DNA"), "an option the row does not carry is not shown").toBeNull();
    expect(within(section).getByText("Card-ready")).toBeInTheDocument();
    expect(within(section).getByText("Awaiting admin approval")).toBeInTheDocument();
    expect(within(section).getByText(/WorkWell sets no default/)).toBeInTheDocument();
  });

  it("names quality staff among the roles that may see it when access is denied", async () => {
    role.current = "ROLE_VIEWER";
    render(<OrdersPage />);
    await waitFor(() => expect(screen.getByText(/lead, quality staff and admins/)).toBeInTheDocument());
  });
});
