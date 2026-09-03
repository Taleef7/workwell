import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardLayout from "../layout";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

let currentRole = "ROLE_CASE_MANAGER";
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: { email: "test@example.com", role: currentRole },
    token: "mock-token",
    logout: vi.fn(),
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/programs",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api/hooks", () => ({
  useApi: () => ({ get: vi.fn().mockResolvedValue([]) }),
}));

vi.mock("@/components/GlobalSearch", () => ({
  GlobalSearch: () => <div data-testid="global-search" />,
}));

beforeEach(() => {
  window.matchMedia = window.matchMedia || vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

describe("DashboardLayout pilot mode", () => {
  beforeEach(() => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";
  });

  it("hides Measures, Studio, Runs, API, and ThemeBrandSwitcher for non-admin in pilot mode", () => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";

    render(
      <DashboardLayout>
        <div>Content</div>
      </DashboardLayout>,
    );

    expect(screen.queryByText("Measures")).toBeNull();
    expect(screen.queryByText("Studio")).toBeNull();
    expect(screen.queryByText("Runs")).toBeNull();
    expect(screen.queryByText("API")).toBeNull();
    expect(screen.queryByLabelText("Brand theme")).toBeNull();

    // Standard non-engineering items remain visible for case manager
    expect(screen.getByText("Programs")).toBeInTheDocument();
    expect(screen.getByText("Cases")).toBeInTheDocument();
  });

  it("shows Measures, Studio, Runs, API, and ThemeBrandSwitcher for admin in pilot mode", () => {
    setPublicDemo(false);
    currentRole = "ROLE_ADMIN";

    render(
      <DashboardLayout>
        <div>Content</div>
      </DashboardLayout>,
    );

    expect(screen.getByText("Measures")).toBeInTheDocument();
    expect(screen.getByText("Studio")).toBeInTheDocument();
    expect(screen.getByText("Runs")).toBeInTheDocument();
    expect(screen.getByText("API")).toBeInTheDocument();
    expect(screen.getByLabelText("Brand theme")).toBeInTheDocument();
  });

  it("companion: with PUBLIC_DEMO=true nothing is hidden for non-admin", () => {
    setPublicDemo(true);
    currentRole = "ROLE_CASE_MANAGER";

    render(
      <DashboardLayout>
        <div>Content</div>
      </DashboardLayout>,
    );

    expect(screen.getByText("Measures")).toBeInTheDocument();
    expect(screen.getByText("Runs")).toBeInTheDocument();
    expect(screen.getByText("API")).toBeInTheDocument();
    expect(screen.getByLabelText("Brand theme")).toBeInTheDocument();
  });
});

