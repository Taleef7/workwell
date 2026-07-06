import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLOW_LOAD_HINT } from "@/lib/useSlowLoadHint";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ from: "", to: "" }) }));

import HierarchyPage from "../page";

beforeEach(() => {
  get.mockReset();
  // Overview + tenants resolve; the rollup call is left pending so `loading` stays true.
  get.mockImplementation((path: string) => {
    if (path.startsWith("/api/hierarchy/rollup")) return new Promise<never>(() => {});
    return Promise.resolve([]);
  });
});
afterEach(() => vi.clearAllMocks());

describe("HierarchyPage — UX-3 slow-load hint", () => {
  it("surfaces the 'Crunching…' hint once the rollup load passes ~3s", async () => {
    vi.useFakeTimers();
    try {
      render(<HierarchyPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.queryByText(SLOW_LOAD_HINT)).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(screen.getByText(SLOW_LOAD_HINT)).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(/Crunching/);
    } finally {
      vi.useRealTimers();
    }
  });
});
