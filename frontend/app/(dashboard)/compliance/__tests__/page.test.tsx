import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLOW_LOAD_HINT } from "@/lib/useSlowLoadHint";
import type { createNavMock } from "@/test/mocks/next-navigation-reactive";

import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const getWithHeaders = vi.fn();
const get = vi.fn();
const post = vi.fn();
// Reactive router mock: push/replace update the params and re-render, like the real App Router.
// (The page derives panel/status from the URL, so a static params mock would make the panel
// <select> a no-op under test.)
const navHolder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createNavMock> }));
vi.mock("next/navigation", async () => {
  const { createNavMock } = await import("@/test/mocks/next-navigation-reactive");
  navHolder.current = createNavMock("/compliance");
  return navHolder.current.navigation as Record<string, unknown>;
});
// The page calls the token-bound useApi() hook (mirrors cases/page.tsx). The real hook returns a
// MEMOIZED (stable) client; mirror that here with a single stable object so the page's effect deps
// don't see a new reference every render (which would refetch on every render).
const apiMock = { getWithHeaders, get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const startTracking = vi.fn();
// Mutable holder so a test can flip isActive without re-mocking (the factory reads it lazily at render).
const runState = { isActive: false };
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: runState.isActive, startTracking }) }));

// Site scoping comes from the shared global filter (header selector / ?site=). Mutable holder so a
// test can change the site between renders (the factory reads it lazily at render).
const siteHolder = { siteId: "" };
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ siteId: siteHolder.siteId }) }));

vi.mock("@/lib/rbac", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac")>();
  return { ...actual };
});
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));

import CompliancePage from "../page";

const rosterImmun = {
  data: {
    panel: "immunizations",
    columns: [
      { measureId: "mmr", name: "MMR", complianceClass: "PERMANENT" },
      { measureId: "varicella", name: "Varicella", complianceClass: "PERMANENT" }
    ],
    rows: [
      {
        subject: { externalId: "emp-001", name: "Ada Lovelace", role: "Nurse", site: "HQ", tenantName: "Acme Health" },
        cells: {
          mmr: { status: "COMPLIANT", method: "2 valid dose(s)" },
          varicella: { status: "IN_PROGRESS", method: "1 of 2 doses on file" }
        }
      }
    ]
  },
  headers: new Headers({ "X-Total-Count": "1" })
};

beforeEach(() => {
  setSubject("employee");
  navHolder.current.setUrl("/compliance");
  // Resolved on a MACROTASK, not immediately. An immediate resolve lets the fetch promise and the
  // React commit land in the same tick often enough that a test awaiting the CALL rather than the
  // RENDER passes locally and fails only on a loaded CI runner. The delay makes that gap deterministic,
  // so this class of bug fails here instead of intermittently in CI. Verified both ways: with the
  // delay in place, awaiting the call reproduces the exact CI error, and awaiting the element passes.
  // Tests below that install their own mock resolve immediately and do not get this property.
  getWithHeaders.mockReset().mockImplementation((url: string) => {
    const match = /panel=(\w+)/.exec(String(url));
    const panel = match ? match[1] : "immunizations";
    return new Promise((r) =>
      setTimeout(
        () =>
          r({
            data: {
              ...rosterImmun.data,
              panel,
            },
            headers: rosterImmun.headers,
          }),
        40
      )
    );
  });
  get.mockReset().mockResolvedValue([]);
  post.mockReset().mockResolvedValue({ runId: "run-9", status: "REQUESTED" });
  startTracking.mockReset();
  runState.isActive = false;
  siteHolder.siteId = "";
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("CompliancePage", () => {
  it("renders the panel's columns and a chip per cell", async () => {
    render(<CompliancePage />);
    expect(await screen.findByText("Individual Compliance Status")).toBeInTheDocument();
    // Wait for the RENDER, not for the fetch to have been called. `getWithHeaders` resolving is not
    // the same event as React committing the resulting state, and a synchronous query in the gap
    // between them reads the empty table — which is how this failed intermittently in CI while
    // passing locally and on a less loaded runner.
    expect(await screen.findByRole("columnheader", { name: /MMR/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Varicella/ })).toBeInTheDocument();
    const row = within(screen.getByRole("table")).getByText("Ada Lovelace").closest("tr")!;
    expect(within(row).getByText("Compliant")).toBeInTheDocument();
    expect(within(row).getByText("In Progress")).toBeInTheDocument();
    expect(within(row).getByText("1 of 2 doses on file")).toBeInTheDocument();
    expect(row).toHaveTextContent("Acme Health · HQ · Nurse");
  });

  it("omits the role from the patient roster subtitle", async () => {
    setSubject("patient");
    render(<CompliancePage />);

    const names = await within(screen.getByRole("table")).findAllByText("Ada Lovelace");
    const row = names[0].closest("tr")!;
    expect(row).toHaveTextContent("Acme Health · HQ");
    expect(row).not.toHaveTextContent("Acme Health · HQ · Nurse");
  });

  it("renders crosswalk label in column header for CMS measures and plain name for OSHA measures", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          {
            id: "cms125",
            name: "Breast Cancer Screening",
            identity: { cmsId: "CMS125", mipsQualityId: "112" },
          },
          {
            id: "audiogram",
            name: "Annual Audiogram Completed",
            identity: null,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    getWithHeaders.mockReset().mockResolvedValue({
      data: {
        panel: "wellness",
        columns: [
          { measureId: "cms125", name: "Breast Cancer Screening", complianceClass: "RECOMMENDED" },
          { measureId: "audiogram", name: "Annual Audiogram Completed", complianceClass: "PERMANENT" },
        ],
        rows: [
          {
            subject: { externalId: "emp-001", name: "Ada Lovelace", role: "Nurse", site: "HQ" },
            cells: {
              cms125: { status: "COMPLIANT", method: "Mammogram on file" },
              audiogram: { status: "COMPLIANT", method: "Audiogram on file" },
            },
          },
        ],
      },
      headers: new Headers({ "X-Total-Count": "1" }),
    });

    render(<CompliancePage />);
    expect(await screen.findByRole("columnheader", { name: /MIPS 112 · CMS125 · Breast Cancer Screening/ })).toBeInTheDocument();
    const audiogramHeader = screen.getByRole("columnheader", { name: /^Annual Audiogram Completed/ });
    expect(audiogramHeader).toBeInTheDocument();
    expect(audiogramHeader).not.toHaveTextContent(/MIPS|CMS/);

    const dt = screen.getByText(/MIPS 112 · CMS125/, { selector: "dt" });
    expect(dt).toBeInTheDocument();
    expect(dt).toHaveTextContent("MIPS 112 · CMS125");
  });

  it("refetches when the panel changes", async () => {
    render(<CompliancePage />);
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalledTimes(1));
    await userEvent.selectOptions(screen.getByLabelText(/Panel/i), "osha");
    await waitFor(() => {
      const calls = getWithHeaders.mock.calls.map((c) => String(c[0]));
      expect(calls.at(-1)).toContain("panel=osha");
    });
  });

  it("Recalculate triggers an ALL_PROGRAMS run and tracks it", async () => {
    render(<CompliancePage />);
    await userEvent.click(await screen.findByRole("button", { name: /Recalculate/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/runs/manual", { scopeType: "ALL_PROGRAMS" }));
    expect(startTracking).toHaveBeenCalledWith("run-9", "REQUESTED");
  });

  it("resets to page 1 when the global site filter changes", async () => {
    // 200 matches over the default page size of 50 → 4 pages, so Next is enabled.
    getWithHeaders.mockReset().mockResolvedValue({
      data: { panel: "immunizations", columns: rosterImmun.data.columns, rows: rosterImmun.data.rows },
      headers: new Headers({ "X-Total-Count": "200" })
    });
    const { rerender } = render(<CompliancePage />);
    // `next` is enabled off the X-Total-Count the fetch returns, so it is data-dependent: waiting for
    // the call rather than the element could click a control the render had not produced yet.
    await userEvent.click(await screen.findByRole("button", { name: /next/i }));
    await waitFor(() => expect(String(getWithHeaders.mock.calls.at(-1)?.[0])).toContain("page=2"));

    siteHolder.siteId = "Plant A"; // dashboard site selector changes externally
    rerender(<CompliancePage />);
    await waitFor(() => {
      const url = String(getWithHeaders.mock.calls.at(-1)?.[0] ?? "");
      expect(url).toContain("site=Plant+A");
      expect(url).toContain("page=1");
    });
  });

  it("disables Recalculate while a run is already active (no duplicate fan-out)", async () => {
    runState.isActive = true;
    render(<CompliancePage />);
    const btn = await screen.findByRole("button", { name: /run in progress/i });
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(post).not.toHaveBeenCalled();
  });

  it("shows an error alert when the roster fetch fails", async () => {
    getWithHeaders.mockReset().mockRejectedValue(new Error("boom"));
    render(<CompliancePage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("boom");
  });

  it("segment filter: selecting a group adds &segment= to the roster request and lists only enabled segments", async () => {
    get.mockReset().mockResolvedValue([
      {
        id: "s1", name: "Clinical Staff", enabled: true,
        rule: { match: "ANY", conditions: [] }, measureIds: [], overrides: [],
        description: "", createdBy: "", createdAt: "", updatedAt: ""
      },
      {
        id: "s2", name: "Disabled One", enabled: false,
        rule: { match: "ANY", conditions: [] }, measureIds: [], overrides: [],
        description: "", createdBy: "", createdAt: "", updatedAt: ""
      }
    ]);
    render(<CompliancePage />);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/segments"));
    const segmentSelect = await screen.findByLabelText(/Segment/i);
    // only the enabled segment is an option (plus the "All segments" default)
    expect(within(segmentSelect).getByRole("option", { name: "Clinical Staff" })).toBeInTheDocument();
    expect(within(segmentSelect).queryByRole("option", { name: "Disabled One" })).not.toBeInTheDocument();
    await userEvent.selectOptions(segmentSelect, "s1");
    await waitFor(() => {
      const lastUrl = String(getWithHeaders.mock.calls.at(-1)?.[0] ?? "");
      expect(lastUrl).toContain("segment=s1");
    });
  });

  it("UX-3: optimistic panel caching — switching A→B→A serves A from cache (no third fetch, no skeleton)", async () => {
    // Panel-aware mock: each panel returns a distinct employee so we can tell which data is on screen.
    const rosterFor = (panel: string) => ({
      data: {
        panel,
        columns: [{ measureId: "m1", name: "Measure One", complianceClass: "RECURRING" }],
        rows: [
          {
            subject: { externalId: `emp-${panel}`, name: `Person ${panel}`, role: "Nurse", site: "HQ" },
            cells: { m1: { status: "COMPLIANT", method: "ok" } }
          }
        ]
      },
      headers: new Headers({ "X-Total-Count": "1" })
    });
    getWithHeaders.mockReset().mockImplementation((url: string) => {
      const panel = /panel=(\w+)/.exec(String(url))?.[1] ?? "immunizations";
      return Promise.resolve(rosterFor(panel));
    });
    const immFetches = () =>
      getWithHeaders.mock.calls.filter((c) => String(c[0]).includes("panel=immunizations")).length;

    render(<CompliancePage />);
    const table = () => screen.getByRole("table");
    await waitFor(() => expect(within(table()).getByText("Person immunizations")).toBeInTheDocument());
    expect(immFetches()).toBe(1);

    // A → B
    await userEvent.selectOptions(screen.getByLabelText(/Panel/i), "osha");
    await waitFor(() => expect(within(table()).getByText("Person osha")).toBeInTheDocument());

    // B → A: cached, so no third fetch for immunizations and A's rows paint immediately (no "Loading…").
    await userEvent.selectOptions(screen.getByLabelText(/Panel/i), "immunizations");
    await waitFor(() => expect(within(table()).getByText("Person immunizations")).toBeInTheDocument());
    expect(within(table()).queryByText("Loading…")).not.toBeInTheDocument();
    expect(immFetches()).toBe(1); // still one — the return trip was served from the session cache
  });

  it("UX-3: shows the >3s 'Crunching…' hint while a slow load is in flight, then clears it", async () => {
    vi.useFakeTimers();
    try {
      // A load that never resolves keeps `loading` true so the >3s timer can fire.
      getWithHeaders.mockReset().mockReturnValue(new Promise<never>(() => {}));
      render(<CompliancePage />);
      // Flush the load-defer setTimeout(0) so the fetch starts and `loading` flips true.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.queryByText(SLOW_LOAD_HINT)).not.toBeInTheDocument();

      // Cross the ~3s threshold → the honest hint appears (visible + announced via aria-live).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(screen.getByText(SLOW_LOAD_HINT)).toBeInTheDocument();
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent(/Crunching/);

      // Resolve the load → the hint clears.
      await act(async () => {
        getWithHeaders.mockReset().mockResolvedValue(rosterImmun);
        // Trigger a re-fetch resolution by advancing past the debounce so a fresh load can settle.
        window.dispatchEvent(new Event("ww:run-complete"));
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.queryByText(SLOW_LOAD_HINT)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an empty-state row when no employees match", async () => {
    getWithHeaders.mockReset().mockResolvedValue({
      data: { panel: "immunizations", columns: rosterImmun.data.columns, rows: [] },
      headers: new Headers({ "X-Total-Count": "0" })
    });
    render(<CompliancePage />);
    // The empty-state string now renders in both the table and the mobile cards (UX-11), so scope the
    // assertion to the table row this test is about.
    const table = await screen.findByRole("table");
    expect(within(table).getByText("No employees match these filters.")).toBeInTheDocument();
  });

  it("renders only availablePanels in the select when supplied by the server", async () => {
    getWithHeaders.mockReset().mockResolvedValue({
      data: {
        panel: "wellness",
        availablePanels: ["wellness"],
        columns: [{ measureId: "hypertension", name: "Hypertension", complianceClass: "RECURRING" }],
        rows: []
      },
      headers: new Headers({ "X-Total-Count": "0" })
    });
    render(<CompliancePage />);
    await screen.findByRole("columnheader", { name: /Hypertension/ });
    const panelSelect = screen.getByLabelText(/Panel/i);
    const options = within(panelSelect).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Wellness & eCQM");
  });

  it("pins panel select value: shows canonicalised panel on Maui responses, and shows selected panel immediately while loading a cold panel", async () => {
    // Part 1: Maui canonicalised panel
    // Start with panel=immunizations in URL, server canonicalises to "wellness".
    // Keep URL panel as immunizations to assert select reflects the canonicalised roster.panel.
    navHolder.current.setUrl("/compliance?panel=immunizations");
    navHolder.current.replace.mockImplementationOnce(() => {});
    getWithHeaders.mockReset().mockResolvedValue({
      data: {
        panel: "wellness",
        availablePanels: ["immunizations", "osha", "wellness"],
        columns: [{ measureId: "m1", name: "Hypertension", complianceClass: "RECURRING" }],
        rows: []
      },
      headers: new Headers({ "X-Total-Count": "0" })
    });
    const { unmount } = render(<CompliancePage />);
    await waitFor(() => {
      const select = screen.getByLabelText<HTMLSelectElement>(/Panel/i);
      expect(select.value).toBe("wellness");
    });
    unmount();

    // Part 2: Cold panel selection on default profile
    // Start loaded with panel=immunizations
    navHolder.current.setUrl("/compliance?panel=immunizations");
    let resolveCold: (val: unknown) => void;
    getWithHeaders.mockReset().mockImplementation((url: string) => {
      if (String(url).includes("panel=osha")) {
        return new Promise((resolve) => {
          resolveCold = resolve;
        });
      }
      return Promise.resolve({
        data: {
          panel: "immunizations",
          availablePanels: ["immunizations", "osha", "wellness"],
          columns: [{ measureId: "mmr", name: "MMR", complianceClass: "PERMANENT" }],
          rows: []
        },
        headers: new Headers({ "X-Total-Count": "0" })
      });
    });

    render(<CompliancePage />);
    await waitFor(() => {
      const select = screen.getByLabelText<HTMLSelectElement>(/Panel/i);
      expect(select.value).toBe("immunizations");
    });

    // User selects "osha" (cold panel)
    await userEvent.selectOptions(screen.getByLabelText(/Panel/i), "osha");

    // While osha is still loading (resolveCold not called yet), the select must show "osha" immediately
    const select = screen.getByLabelText<HTMLSelectElement>(/Panel/i);
    expect(select.value).toBe("osha");

    // Resolve the pending fetch
    await act(async () => {
      resolveCold!({
        data: {
          panel: "osha",
          availablePanels: ["immunizations", "osha", "wellness"],
          columns: [{ measureId: "audiogram", name: "Audiogram", complianceClass: "PERMANENT" }],
          rows: []
        },
        headers: new Headers({ "X-Total-Count": "0" })
      });
    });
  });

  it("renders deployment empty-panels state when availablePanels is empty", async () => {
    getWithHeaders.mockReset().mockResolvedValue({
      data: {
        panel: "immunizations",
        availablePanels: [],
        columns: [],
        rows: [],
      },
      headers: new Headers({ "X-Total-Count": "0" }),
    });

    render(<CompliancePage />);
    expect(
      await screen.findByText("No compliance panel is configured for this deployment.")
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Panel/i)).not.toBeInTheDocument();
  });
});
