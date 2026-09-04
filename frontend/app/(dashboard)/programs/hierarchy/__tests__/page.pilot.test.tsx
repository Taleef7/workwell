import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HierarchyPage from "../page";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

let currentRole = "ROLE_CASE_MANAGER";
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: currentRole } }),
}));

const get = vi.fn();
vi.mock("@/lib/api/hooks", () => ({
  useApi: () => ({ get }),
}));

vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ from: "", to: "" }),
}));

describe("HierarchyPage pilot mode controls", () => {
  beforeEach(() => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";
    get.mockImplementation((path: string) => {
      if (path === "/api/tenants") return Promise.resolve([{ id: "t1", name: "Tenant 1" }]);
      if (path.startsWith("/api/programs/overview")) return Promise.resolve([]);
      if (path.startsWith("/api/hierarchy/rollup")) {
        return Promise.resolve({
          level: "all",
          id: "all",
          name: "All Systems",
          evaluated: 10,
          compliant: 10,
          dueSoon: 0,
          overdue: 0,
          missingData: 0,
          excluded: 0,
          complianceRate: 100,
          openCases: 0,
          children: [],
        });
      }
      return Promise.resolve([]);
    });
  });

  it("hides System selector for non-admin in pilot mode", async () => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";

    render(<HierarchyPage />);

    await waitFor(() => {
      expect(screen.getByText("Compliance Hierarchy")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("System")).toBeNull();
  });

  it("shows System selector for admin in pilot mode", async () => {
    setPublicDemo(false);
    currentRole = "ROLE_ADMIN";

    render(<HierarchyPage />);

    await waitFor(() => {
      expect(screen.getByText("Compliance Hierarchy")).toBeInTheDocument();
    });

    expect(screen.getByLabelText("System")).toBeInTheDocument();
  });

  it("companion: shows System selector for non-admin when PUBLIC_DEMO is true", async () => {
    setPublicDemo(true);
    currentRole = "ROLE_CASE_MANAGER";

    render(<HierarchyPage />);

    await waitFor(() => {
      expect(screen.getByText("Compliance Hierarchy")).toBeInTheDocument();
    });

    expect(screen.getByLabelText("System")).toBeInTheDocument();
  });
});


