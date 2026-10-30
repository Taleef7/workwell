import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Imported before the layout: the mock below reads `subject` while the layout's imports load.
import { setSubject, subject } from "@/test/mocks/terminology";
import DashboardLayout from "../layout";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));
// The employee deployment unless a test says otherwise: the Scorecard is a patient-deployment item.
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

let currentRole = "ROLE_CASE_MANAGER";
// One user object per role, as the real provider yields: a fresh object per render would re-fire
// every `[user]` effect in the layout.
const usersByRole = new Map<string, { email: string; role: string }>();
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => {
    let user = usersByRole.get(currentRole);
    if (!user) {
      user = { email: "test@example.com", role: currentRole };
      usersByRole.set(currentRole, user);
    }
    return { user, token: "mock-token", logout: vi.fn() };
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/programs",
  useSearchParams: () => new URLSearchParams(),
}));

const getWithHeaders = vi.fn();
// A stable object, as the real hook returns: a fresh one per render would re-fire every `[api]` effect.
const apiMock = { get: vi.fn().mockResolvedValue([]), getWithHeaders };
vi.mock("@/lib/api/hooks", () => ({
  useApi: () => apiMock,
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

beforeEach(() => {
  getWithHeaders.mockReset().mockResolvedValue({ data: [], headers: new Headers({ "X-Total-Count": "0" }) });
  apiMock.get.mockReset().mockResolvedValue([]);
});

describe("DashboardLayout Worklist badge", () => {
  it("reads the gap count from X-Total-Count via outreach=none&limit=1, not from the rows it received", async () => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";
    // One row in the body, 137 in the header: the badge must say 137.
    getWithHeaders.mockResolvedValue({
      data: [{ caseId: "case-1", outreachRecordCount: 0 }],
      headers: new Headers({ "X-Total-Count": "137" }),
    });

    render(
      <DashboardLayout>
        <div>Content</div>
      </DashboardLayout>,
    );

    await waitFor(() => expect(screen.getByText("137")).toBeInTheDocument());
    expect(screen.queryByText("1", { exact: true })).toBeNull();

    expect(getWithHeaders).toHaveBeenCalledTimes(1);
    const url = String(getWithHeaders.mock.calls[0][0]);
    expect(url.startsWith("/api/cases?")).toBe(true);
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(params.get("status")).toBe("open");
    expect(params.get("outreach")).toBe("none");
    expect(params.get("limit")).toBe("1");
  });
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

// The real MyProviderProvider runs here (DashboardLayout mounts it); only the API answer is stubbed.
describe("DashboardLayout — a clinician's own scorecard (#870)", () => {
  const SILVA = { id: "maui-prov-011", name: "Dr. Ana Silva", location: "Wailuku" };
  const answerMine = (answer: () => Promise<unknown>) =>
    apiMock.get.mockImplementation((url: string) => (url === "/api/providers/mine" ? answer() : Promise.resolve([])));
  const mineCalls = () => apiMock.get.mock.calls.filter((c) => c[0] === "/api/providers/mine").length;
  const renderShell = () =>
    render(
      <DashboardLayout>
        <div>Content</div>
      </DashboardLayout>,
    );

  beforeEach(() => {
    setPublicDemo(false);
    setSubject("patient");
    currentRole = "ROLE_VIEWER";
  });
  afterEach(() => setSubject("employee"));

  it("shows a linked viewer My scorecard, and their provider on the user card", async () => {
    answerMine(() => Promise.resolve({ provider: SILVA }));
    renderShell();
    const item = await screen.findByTestId("nav-scorecard");
    expect(item).toHaveTextContent("My scorecard");
    const roleLine = screen.getByText("Viewer · Dr. Ana Silva");
    expect(roleLine).toHaveAttribute("title", "Viewer · Dr. Ana Silva");
    expect(roleLine).toHaveClass("truncate");
    expect(mineCalls()).toBe(1);
  });

  it("shows an unlinked viewer no Scorecard and a plain role line", async () => {
    answerMine(() => Promise.resolve({ provider: null }));
    renderShell();
    await waitFor(() => expect(mineCalls()).toBe(1));
    await act(async () => {});
    expect(screen.queryByTestId("nav-scorecard")).toBeNull();
    expect(screen.getByText("Viewer")).not.toHaveAttribute("title");
  });

  it("shows no Scorecard while the read is pending or after it failed", async () => {
    let fail: (e: Error) => void = () => {};
    answerMine(() => new Promise((_, reject) => { fail = reject; }));
    renderShell();
    await waitFor(() => expect(mineCalls()).toBe(1));
    expect(screen.queryByTestId("nav-scorecard")).toBeNull();
    await act(async () => fail(new Error("502")));
    expect(screen.queryByTestId("nav-scorecard")).toBeNull();
    expect(screen.getByText("Viewer")).toBeInTheDocument();
  });

  it("shows a viewer nothing on the occupational deployment, and never asks who they are linked to", async () => {
    setSubject("employee");
    answerMine(() => Promise.resolve({ provider: SILVA }));
    renderShell();
    await act(async () => {});
    expect(mineCalls()).toBe(0);
    expect(screen.queryByTestId("nav-scorecard")).toBeNull();
  });

  it("keeps a case manager's Scorecard as it was, and never asks who they are linked to", async () => {
    currentRole = "ROLE_CASE_MANAGER";
    answerMine(() => Promise.resolve({ provider: SILVA }));
    renderShell();
    const item = screen.getByTestId("nav-scorecard");
    await act(async () => {});
    expect(item.textContent?.trim()).toBe("Scorecard");
    expect(screen.getByText("Case Manager")).not.toHaveAttribute("title");
    expect(mineCalls()).toBe(0);
  });
});

