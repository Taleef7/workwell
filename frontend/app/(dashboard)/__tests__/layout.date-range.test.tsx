import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardLayout from "../layout";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

const user = { email: "test@example.com", role: "ROLE_ADMIN" };
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user, token: "mock-token", logout: vi.fn() }),
}));

let currentPath = "/programs";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => currentPath,
  useSearchParams: () => new URLSearchParams(),
}));

const apiMock = {
  get: vi.fn().mockResolvedValue([]),
  getWithHeaders: vi.fn().mockResolvedValue({ data: [], headers: new Headers({ "X-Total-Count": "0" }) }),
};
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

vi.mock("@/components/GlobalSearch", () => ({
  GlobalSearch: () => <div data-testid="global-search" />,
}));

beforeEach(() => {
  setPublicDemo(false);
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

const renderAt = (path: string) => {
  currentPath = path;
  return render(
    <DashboardLayout>
      <div>Content</div>
    </DashboardLayout>,
  );
};

// Both the desktop header and the mobile bar carry the selectors, so each count is per layout.
describe("DashboardLayout date range (#699)", () => {
  it.each(["/programs", "/programs/hierarchy", "/programs/cms125"])(
    "hides the date range on %s, whose figures are measurement-year rates",
    (path) => {
      renderAt(path);
      expect(screen.queryAllByLabelText("Date range")).toHaveLength(0);
      // Only the range goes; the site selector is untouched.
      expect(screen.getAllByLabelText("Filter by site")).toHaveLength(2);
    },
  );

  it.each(["/worklist", "/cases", "/runs", "/programsx"])("keeps the date range on %s", (path) => {
    renderAt(path);
    expect(screen.getAllByLabelText("Date range")).toHaveLength(2);
  });
});
