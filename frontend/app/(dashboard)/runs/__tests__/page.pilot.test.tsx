import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RunsPage from "../page";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

let currentRole = "ROLE_CASE_MANAGER";
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: currentRole } }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api/hooks", () => ({
  useApi: () => ({ get, post }),
}));

vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "", to: "" }),
}));

vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

describe("RunsPage pilot mode route guard", () => {
  beforeEach(() => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";
    get.mockReset().mockResolvedValue([]);
  });

  it("renders access denied for non-admin in pilot mode", () => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";

    render(<RunsPage />);

    expect(screen.getByText("Runs")).toBeInTheDocument();
    expect(screen.getByText(/Your current role does not have access to this section/i)).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("renders run history for admin in pilot mode", () => {
    setPublicDemo(false);
    currentRole = "ROLE_ADMIN";

    render(<RunsPage />);

    expect(screen.queryByText(/Your current role does not have access to this section/i)).toBeNull();
    expect(screen.getByText("Run History")).toBeInTheDocument();
  });

  it("companion: renders run history for non-admin when PUBLIC_DEMO is true", () => {
    setPublicDemo(true);
    currentRole = "ROLE_CASE_MANAGER";

    render(<RunsPage />);

    expect(screen.queryByText(/Your current role does not have access to this section/i)).toBeNull();
    expect(screen.getByText("Run History")).toBeInTheDocument();
  });
});
