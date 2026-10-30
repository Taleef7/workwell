/**
 * The clinician's "My patients" on the roster (#870): one click to the PCP filter for the provider their
 * sign-in is linked to, written exactly as the PCP select writes it. Nothing narrows on its own, so a
 * Programs chip still lands on the practice-wide count it was clicked for.
 */
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createNavMock } from "@/test/mocks/next-navigation-reactive";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const getWithHeaders = vi.fn();
const get = vi.fn();
const apiMock = { getWithHeaders, get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const navHolder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createNavMock> }));
vi.mock("next/navigation", async () => {
  const { createNavMock } = await import("@/test/mocks/next-navigation-reactive");
  navHolder.current = createNavMock("/compliance");
  return navHolder.current.navigation;
});

const auth = vi.hoisted(() => ({ role: "ROLE_VIEWER" }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: auth.role } }),
}));
vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "", to: "" }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));
const mine = vi.hoisted(() => ({
  provider: null as { id: string; name: string; location: string } | null,
}));
vi.mock("@/features/panel/use-my-provider", () => ({
  useMyProvider: () => ({ provider: mine.provider, loaded: true, error: false, retry: () => {} }),
}));

import CompliancePage from "../page";

const SILVA = { id: "maui-prov-011", name: "Dr. Ana Silva", location: "Wailuku" };
const PROVIDERS = [SILVA, { id: "maui-prov-012", name: "Dr. Aven Stone", location: "Kahului Clinic" }];

function rosterCalls(): string[] {
  return getWithHeaders.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/compliance/roster?"));
}

beforeEach(() => {
  setSubject("patient");
  auth.role = "ROLE_VIEWER";
  mine.provider = SILVA;
  navHolder.current.setUrl("/compliance");
  get.mockReset().mockImplementation((url: string) =>
    String(url) === "/api/providers" ? Promise.resolve(PROVIDERS) : Promise.resolve([]),
  );
  // The server answers with the panel asked for, so nothing canonicalizes the URL behind the test.
  getWithHeaders.mockReset().mockImplementation((url: string) => {
    const panel = /panel=(\w+)/.exec(String(url))?.[1] ?? "immunizations";
    return Promise.resolve({ data: { panel, columns: [], rows: [] }, headers: new Headers({ "X-Total-Count": "0" }) });
  });
});
afterEach(() => {
  setSubject("employee");
  vi.clearAllMocks();
});

describe("CompliancePage — My patients (#870)", () => {
  it("narrows a linked viewer's roster to their provider, as choosing them in the PCP select does", async () => {
    navHolder.current.setUrl("/compliance?measureId=cms125");
    render(<CompliancePage />);
    const button = await screen.findByTestId("roster-my-patients");
    expect(button).toHaveTextContent("My patients");
    expect(button).toHaveAttribute("aria-pressed", "false");

    await act(async () => {
      await userEvent.click(button);
    });
    expect(navHolder.current.push).toHaveBeenCalledTimes(1);
    expect(navHolder.current.push).toHaveBeenCalledWith("/compliance?measureId=cms125&providerId=maui-prov-011");
    await waitFor(() => expect(rosterCalls().at(-1)).toContain("providerId=maui-prov-011"));
    expect(screen.getByLabelText("PCP")).toHaveValue("maui-prov-011");
    expect(screen.getByTestId("roster-my-patients")).toHaveAttribute("aria-pressed", "true");
  });

  it("narrows nothing on load: a Programs chip lands on the practice-wide roster", async () => {
    navHolder.current.setUrl("/compliance?measureId=cms125&status=OVERDUE");
    render(<CompliancePage />);
    await screen.findByTestId("roster-my-patients");
    await waitFor(() => expect(rosterCalls().length).toBeGreaterThan(0));
    for (const call of rosterCalls()) expect(call).not.toContain("providerId=");
    expect(navHolder.current.push).not.toHaveBeenCalled();
    expect(navHolder.current.replace).not.toHaveBeenCalled();
    expect(navHolder.current.params.get("providerId")).toBeNull();
  });

  it("shows itself pressed when the roster is already theirs, and pressing it again changes nothing", async () => {
    navHolder.current.setUrl("/compliance?providerId=maui-prov-011");
    render(<CompliancePage />);
    const button = await screen.findByTestId("roster-my-patients");
    expect(button).toHaveAttribute("aria-pressed", "true");
    await act(async () => {
      await userEvent.click(button);
    });
    expect(navHolder.current.push).not.toHaveBeenCalled();
  });

  it("is not offered to an unlinked viewer", async () => {
    mine.provider = null;
    render(<CompliancePage />);
    await screen.findByLabelText("PCP");
    await waitFor(() => expect(rosterCalls().length).toBeGreaterThan(0));
    expect(screen.queryByTestId("roster-my-patients")).toBeNull();
  });
  // A case manager is never offered it because the hook names no provider for one: that is the hook's own
  // test, and a copy here with the provider set to null would be the unlinked case again.
});
