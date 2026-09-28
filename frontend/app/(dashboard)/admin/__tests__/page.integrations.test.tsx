import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

const get = vi.fn();
const apiMock = { get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "", to: "" }),
}));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));
vi.mock("@/features/datavis/NitroGridClient", () => ({ default: () => null }));
vi.mock("@/features/segments/SegmentsAdmin", () => ({ SegmentsAdmin: () => null }));

import AdminPage from "../page";

const TILES = [
  { integration: "webchart", displayName: "WebChart", status: "not-configured", lastSyncAt: null, detail: "Not connected: this deployment evaluates synthetic patients.", config: {} },
  { integration: "fhir", displayName: "Measure evaluation", status: "healthy", lastSyncAt: null, detail: "The CQL engine runs in this process, over synthetic patients.", config: {} },
];

// #627: Manual Sync contacted nothing and reported "Manual sync completed", and every tile's "Last sync"
// was the container's boot time. The tiles are status only now.
describe("Admin integration health (#627)", () => {
  it("shows status-only tiles: no Manual Sync, no invented time, and the WebChart tile", async () => {
    get.mockImplementation((url: string) =>
      url === "/api/admin/integrations"
        ? Promise.resolve(TILES)
        : url === "/api/admin/scheduler"
          ? Promise.resolve({ enabled: false, cron: "0 0 12 * * *", nextFireAt: null, lastRunAt: null, lastRunStatus: null })
          : Promise.resolve([]),
    );
    render(<AdminPage />);
    const webchart = (await screen.findByText("WebChart")).parentElement!;
    expect(within(webchart).getByText("Not Configured")).toBeInTheDocument();
    expect(within(webchart).getByText("Not connected: this deployment evaluates synthetic patients.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manual sync/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Last (sync|fetch)/)).not.toBeInTheDocument();
  });

  it("shows a last fetch time only on a tile that has one", async () => {
    get.mockImplementation((url: string) =>
      url === "/api/admin/integrations"
        ? Promise.resolve([{ ...TILES[0], status: "configured", lastSyncAt: "2026-09-28T12:59:00.000Z", detail: "Tenant tenant.example. Last fetch: 812 patients, 3 degraded (completed)." }, TILES[1]])
        : Promise.resolve([]),
    );
    render(<AdminPage />);
    const webchart = (await screen.findByText("WebChart")).parentElement!;
    expect(within(webchart).getByText(/^Last fetch:/)).toBeInTheDocument();
    expect(screen.getAllByText(/^Last fetch:/)).toHaveLength(1);
  });
});
