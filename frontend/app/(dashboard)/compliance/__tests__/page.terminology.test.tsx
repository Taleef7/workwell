import React from "react";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getWithHeaders = vi.fn();
const get = vi.fn();
const post = vi.fn();
// Reactive router mock (same template as page.test.tsx) — the page derives panel/status from the URL.
const navHolder = vi.hoisted(() => ({ current: undefined as unknown as { navigation: unknown; setUrl: (u: string) => void } }));
vi.mock("next/navigation", async () => {
  const { createNavMock } = await import("@/test/mocks/next-navigation-reactive");
  navHolder.current = createNavMock("/compliance");
  return navHolder.current.navigation as Record<string, unknown>;
});
// Stable useApi() client object, mirroring the real hook's memoization (see page.test.tsx).
const apiMock = { getWithHeaders, get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }) }));
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ siteId: "" }) }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));

beforeEach(() => {
  // The nav-mock factory only runs on the page's (dynamic) import, so it may not exist yet here.
  navHolder.current?.setUrl("/compliance");
  getWithHeaders.mockReset().mockResolvedValue({
    data: { panel: "immunizations", columns: [], rows: [] },
    headers: new Headers({ "X-Total-Count": "0" }),
  });
  get.mockReset().mockResolvedValue([]);
  post.mockReset().mockResolvedValue({});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("CompliancePage terminology (NEXT_PUBLIC_SUBJECT_TERM=patient)", () => {
  it("renders patient wording in the empty state and the sticky first column header", async () => {
    // The subject term is read at module load, so stub the env, reset the module
    // registry, and import the page fresh inside the test.
    vi.stubEnv("NEXT_PUBLIC_SUBJECT_TERM", "patient");
    vi.resetModules();
    const { default: CompliancePage } = await import("../page");
    render(<CompliancePage />);
    const table = await screen.findByRole("table");
    expect(within(table).getByText("No patients match these filters.")).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Patient" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("Panel")).getByRole("option", { name: "Quality measures" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("Panel")).queryByRole("option", { name: "Wellness & eCQM" })).not.toBeInTheDocument();
  });
});
