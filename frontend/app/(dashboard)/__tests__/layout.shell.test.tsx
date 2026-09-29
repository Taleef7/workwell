import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DashboardLayout from "../layout";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

const user = { email: "test@example.com", role: "ROLE_CASE_MANAGER" };
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user, token: "mock-token", logout: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/worklist",
  useSearchParams: () => new URLSearchParams(),
}));

const apiMock = {
  get: vi.fn().mockResolvedValue([]),
  getWithHeaders: vi.fn().mockResolvedValue({ data: [], headers: new Headers({ "X-Total-Count": "0" }) }),
};
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

/** The sidebar decides phone vs desktop with `(max-width: 1023px)`; answer it as a phone or a desktop. */
function viewport(phone: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone ? query.includes("max-width: 1023px") : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

const renderShell = () =>
  render(
    <DashboardLayout>
      <div>Content</div>
    </DashboardLayout>,
  );

beforeEach(() => setPublicDemo(false));
afterEach(() => vi.unstubAllGlobals());

describe("DashboardLayout shell on a phone (#700)", () => {
  it("keeps the closed drawer out of the tab order, focuses the current page on open, and closes on Escape", async () => {
    viewport(true);
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    // Closed: inert, so its twelve links are not reachable by an invisible Tab.
    expect(nav.inert).toBe(true);

    const toggle = screen.getByRole("button", { name: "Open navigation" });
    await act(async () => fireEvent.click(toggle));
    expect(nav.inert).toBe(false);
    const current = screen.getByTestId("nav-worklist");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(document.activeElement).toBe(current);

    await act(async () => fireEvent.keyDown(document, { key: "Escape" }));
    expect(nav.inert).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it("gives the menu button a 44px target and shows search on a phone", () => {
    viewport(true);
    renderShell();
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveClass("h-11", "w-11");
    const search = screen.getByRole("textbox", { name: /search/i });
    // Visible at every width (it was `hidden sm:block`), with 16px text so iOS does not zoom on focus.
    expect(search.closest("div.relative")?.parentElement).not.toHaveClass("hidden");
    expect(search).toHaveClass("text-base");
  });
});

describe("DashboardLayout shell on a desktop", () => {
  it("never makes the desktop sidebar inert, and marks the current page", () => {
    viewport(false);
    renderShell();
    expect(screen.getByRole("navigation", { name: "Main navigation" }).inert).toBe(false);
    expect(screen.getByTestId("nav-worklist")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("nav-cases")).not.toHaveAttribute("aria-current");
  });

  it("puts the header's filters at xl, so 1024 to 1279px uses the filter bar below it", () => {
    viewport(false);
    renderShell();
    const [headerSite] = screen.getAllByLabelText("Filter by site");
    expect(headerSite!.closest(".xl\\:flex")).not.toBeNull();
  });
});
