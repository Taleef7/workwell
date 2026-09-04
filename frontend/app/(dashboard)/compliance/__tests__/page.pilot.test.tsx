import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CompliancePage from "../page";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

let currentRole = "ROLE_CASE_MANAGER";
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: currentRole } }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/compliance",
  useSearchParams: () => new URLSearchParams(),
}));

const getWithHeaders = vi.fn();
const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api/hooks", () => ({
  useApi: () => ({ getWithHeaders, get, post }),
}));

vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "", to: "" }),
}));

vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

describe("CompliancePage pilot mode controls", () => {
  beforeEach(() => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";
    get.mockResolvedValue([]);
    getWithHeaders.mockResolvedValue({
      data: { panel: "immunizations", availablePanels: [], columns: [], rows: [] },
      headers: new Headers({ "X-Total-Count": "0" }),
    });
  });

  it("hides Recalculate button for non-admin in pilot mode", async () => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";

    render(<CompliancePage />);

    await waitFor(() => {
      expect(screen.getByText("Individual Compliance Status")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: /Recalculate/i })).toBeNull();
  });

  it("shows Recalculate button for admin in pilot mode", async () => {
    setPublicDemo(false);
    currentRole = "ROLE_ADMIN";

    render(<CompliancePage />);

    await waitFor(() => {
      expect(screen.getByText("Individual Compliance Status")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /Recalculate/i })).toBeInTheDocument();
  });

  it("hides the System selector for non-admin in pilot mode", async () => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";

    render(<CompliancePage />);

    await waitFor(() => {
      expect(screen.getByText("Individual Compliance Status")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("System")).toBeNull();
  });

  it("shows the System selector for admin in pilot mode and for anyone on the public demo", async () => {
    // A served panel keeps the filter bar mounted after the roster lands, so the assertion observes
    // the settled UI rather than the first render.
    getWithHeaders.mockResolvedValue({
      data: { panel: "immunizations", availablePanels: ["immunizations"], columns: [], rows: [] },
      headers: new Headers({ "X-Total-Count": "0" }),
    });

    setPublicDemo(false);
    currentRole = "ROLE_ADMIN";
    const { unmount } = render(<CompliancePage />);
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalled());
    expect(await screen.findByLabelText("System")).toBeInTheDocument();
    unmount();

    setPublicDemo(true);
    currentRole = "ROLE_CASE_MANAGER";
    getWithHeaders.mockClear();
    render(<CompliancePage />);
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalled());
    expect(await screen.findByLabelText("System")).toBeInTheDocument();
  });

  it("companion: shows Recalculate button for non-admin when PUBLIC_DEMO is true", async () => {
    setPublicDemo(true);
    currentRole = "ROLE_CASE_MANAGER";

    render(<CompliancePage />);

    await waitFor(() => {
      expect(screen.getByText("Individual Compliance Status")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /Recalculate/i })).toBeInTheDocument();
  });
});

