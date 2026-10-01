import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DashboardLayout from "../layout";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

const user = { email: "test@example.com", role: "ROLE_CASE_MANAGER" };
const auth = { token: "mock-token" as string | null, reconnecting: false };
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user, token: auth.token, reconnecting: auth.reconnecting, logout: vi.fn() }),
}));

let pathname = "/worklist";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}));

const apiMock = {
  get: vi.fn().mockResolvedValue([]),
  getWithHeaders: vi.fn().mockResolvedValue({ data: [], headers: new Headers({ "X-Total-Count": "0" }) }),
};
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

/**
 * The sidebar decides phone vs desktop with `(max-width: 1023px)`. The stub answers it as a phone or a
 * desktop and keeps the `change` listeners, so a test can rotate the device mid-session.
 */
let phone = false;
const listeners = new Set<(e: { matches: boolean }) => void>();
function viewport(isPhone: boolean) {
  phone = isPhone;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return phone ? query.includes("max-width: 1023px") : false;
    },
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
      if (query.includes("max-width: 1023px")) listeners.add(fn);
    },
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
    dispatchEvent: vi.fn(),
  }));
}
async function rotate(isPhone: boolean) {
  phone = isPhone;
  await act(async () => listeners.forEach((fn) => fn({ matches: isPhone })));
}

const renderShell = () =>
  render(
    <DashboardLayout>
      <div>Content</div>
    </DashboardLayout>,
  );

beforeEach(() => {
  setPublicDemo(false);
  auth.token = "mock-token";
  auth.reconnecting = false;
  pathname = "/worklist";
  listeners.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("DashboardLayout shell on a phone (#700)", () => {
  it("keeps the closed drawer out of the tab order, focuses the current page on open, and closes on Escape", async () => {
    viewport(true);
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    // Closed: inert, so its twelve links are not reachable by an invisible Tab. Loading the page moves
    // no focus: the menu button is focused only after the drawer was open.
    expect(nav.inert).toBe(true);
    expect(document.activeElement).toBe(document.body);

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

  it("makes the page behind the open drawer inert, and gives it back on close", async () => {
    viewport(true);
    renderShell();
    const main = document.getElementById("shell-main")!;
    const skip = screen.getByText("Skip to content");
    expect(main.inert).toBe(false);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open navigation" })));
    expect(main.inert).toBe(true);
    expect(skip.inert).toBe(true);

    await act(async () => fireEvent.keyDown(document, { key: "Escape" }));
    expect(main.inert).toBe(false);
    expect(skip.inert).toBe(false);
  });

  it("closes the drawer on a nav tap and returns focus to the menu button", async () => {
    viewport(true);
    renderShell();
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    await act(async () => fireEvent.click(toggle));
    const cases = screen.getByTestId("nav-cases");
    cases.focus();
    await act(async () => fireEvent.click(cases));
    expect(screen.getByRole("navigation", { name: "Main navigation" }).inert).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open navigation" }));
  });

  it("does not pull focus to the menu button after a rotation to desktop and back", async () => {
    viewport(true);
    renderShell();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open navigation" })));
    // Tablet rotated to landscape: the library closes the drawer, and the user starts typing.
    await rotate(false);
    const search = screen.getByRole("textbox", { name: /search/i });
    search.focus();
    await rotate(true);
    expect(document.activeElement).toBe(search);
    expect(document.getElementById("shell-main")!.inert).toBe(false);
  });

  it("gives the menu button a 44px target and shows search on a phone", () => {
    viewport(true);
    renderShell();
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveClass("h-11", "w-11");
    const search = screen.getByRole("textbox", { name: /search/i });
    // Visible at every width (it was `hidden sm:block`), with 16px text so iOS does not zoom on focus.
    expect(search.closest("div.relative")?.parentElement).not.toHaveClass("hidden");
    expect(search).toHaveClass("text-base");
    // It shrinks only for a mouse or trackpad: a landscape phone or an iPad is wider than sm and still
    // zooms on a focused input under 16px.
    expect(search).not.toHaveClass("sm:text-xs");
    expect(search).toHaveClass("sm:pointer-fine:text-xs");
  });
});

describe("DashboardLayout shell on a desktop", () => {
  it("never makes the desktop sidebar inert, and marks the current page", () => {
    viewport(false);
    renderShell();
    expect(screen.getByRole("navigation", { name: "Main navigation" }).inert).toBe(false);
    expect(document.getElementById("shell-main")!.inert).toBe(false);
    expect(screen.getByTestId("nav-worklist")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("nav-cases")).not.toHaveAttribute("aria-current");
  });

  it("marks the section a nested page belongs to", () => {
    viewport(false);
    pathname = "/cases/abc-123";
    renderShell();
    expect(screen.getByTestId("nav-cases")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("nav-worklist")).not.toHaveAttribute("aria-current");
  });

  it("puts the header's filters at xl, so 1024 to 1279px uses the filter bar below it", () => {
    viewport(false);
    renderShell();
    const [headerSite] = screen.getAllByLabelText("Filter by site");
    expect(headerSite!.closest(".xl\\:flex")).not.toBeNull();
  });
});

describe("DashboardLayout without a session", () => {
  it("says it is reconnecting while a refresh waits out a server restart", () => {
    viewport(false);
    auth.token = null;
    auth.reconnecting = true;
    renderShell();
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting to the server");
    // The way out if the server stays unreachable: a plain link to sign in, which ends nothing.
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/login");
    expect(screen.queryByText("Content")).toBeNull();
  });

  it("shows nothing while a refresh is quick", () => {
    viewport(false);
    auth.token = null;
    renderShell();
    expect(screen.queryByTestId("auth-reconnecting")).toBeNull();
    expect(screen.queryByText("Content")).toBeNull();
  });
});

describe("DashboardLayout — the work list is the daily screen (#698)", () => {
  it("lists Worklist before Cases", () => {
    viewport(false);
    renderShell();
    const worklist = screen.getByTestId("nav-worklist");
    const cases = screen.getByTestId("nav-cases");
    expect(worklist.compareDocumentPosition(cases) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says the badge counts open gaps not yet contacted, not patients", async () => {
    viewport(false);
    apiMock.getWithHeaders.mockResolvedValueOnce({ data: [], headers: new Headers({ "X-Total-Count": "15900" }) });
    renderShell();
    const badge = await screen.findByTestId("worklist-badge");
    expect(badge).toHaveAttribute("title", "15,900 open gaps with no outreach yet");
    expect(badge).toHaveTextContent("15,900 open gaps with no outreach yet");
  });
});
