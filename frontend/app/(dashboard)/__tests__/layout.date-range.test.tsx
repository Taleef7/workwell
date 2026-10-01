import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardLayout from "../layout";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

const user = { email: "test@example.com", role: "ROLE_ADMIN" };
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user, token: "mock-token", logout: vi.fn() }),
}));

let currentPath = "/programs";
let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => currentPath,
  useSearchParams: () => new URLSearchParams(currentSearch),
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

const renderAt = (path: string, search = "") => {
  currentPath = path;
  currentSearch = search;
  return render(
    <DashboardLayout>
      <div>Content</div>
    </DashboardLayout>,
  );
};

// Both the desktop header and the mobile bar carry the selectors, so each count is per layout.
describe("DashboardLayout date range (#699, #661)", () => {
  // Matched on the label's START: the label now says which date it filters, and an exact "Date range"
  // query would find nothing on every page and pass the "hidden" cases for the wrong reason.
  const ranges = () => screen.queryAllByLabelText(/^Date range/);

  it.each(["/programs", "/programs/hierarchy", "/programs/cms125", "/compliance", "/people", "/cases/abc", "/programsx"])(
    "hides the date range on %s, which it does not filter",
    (path) => {
      renderAt(path);
      expect(ranges()).toHaveLength(0);
      // Only the range goes; the site selector is untouched.
      expect(screen.getAllByLabelText("Filter by site")).toHaveLength(2);
    },
  );

  it("hides the date range on the work list's Panels tab, a provider table it does not filter", () => {
    renderAt("/worklist", "tab=panels");
    expect(ranges()).toHaveLength(0);
  });

  it.each([
    ["/worklist", "Date range: when the gap was opened", /^Opened: /],
    ["/cases", "Date range: when the gap was opened", /^Opened: /],
    ["/runs", "Date range: when the run started", /^Started: /],
  ])("on %s it says which date it filters", (path, label, shown) => {
    renderAt(path);
    const controls = screen.getAllByLabelText(label);
    expect(controls).toHaveLength(2);
    for (const control of controls) expect(control).toHaveTextContent(shown);
  });
});

describe("the sidebar's open-gap badge ignores the date range (#661)", () => {
  it("counts by site only, even on a page where a range is chosen", async () => {
    apiMock.getWithHeaders.mockClear();
    renderAt("/worklist", "site=Kihei+Clinic&from=2026-09-24&to=2026-10-01");
    await waitFor(() =>
      expect(apiMock.getWithHeaders.mock.calls.map((c) => String(c[0])).some((u) => u.includes("outreach=none"))).toBe(true),
    );
    const badge = apiMock.getWithHeaders.mock.calls.map((c) => String(c[0])).find((u) => u.includes("outreach=none"))!;
    expect(badge).toContain("site=Kihei");
    expect(badge).not.toMatch(/[?&](from|to)=/);
  });
});
