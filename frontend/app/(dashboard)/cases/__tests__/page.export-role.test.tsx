/**
 * Bulk downloads by role (D5). The backend answers 403 to a cases CSV from anyone but CASE_MANAGER/ADMIN,
 * and to the audit-ledger CSV from anyone but ADMIN, so the cases page offers each button only to the
 * roles that may use it. The list itself stays readable by every signed-in role.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createNavMock } from "@/test/mocks/next-navigation-reactive";

const getWithHeaders = vi.fn();
const get = vi.fn();
const apiMock = { getWithHeaders, get, downloadBlob: vi.fn() };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const navHolder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createNavMock> }));
vi.mock("next/navigation", async () => {
  const { createNavMock } = await import("@/test/mocks/next-navigation-reactive");
  navHolder.current = createNavMock("/cases");
  return navHolder.current.navigation;
});
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ siteId: "", from: "", to: "" }) }));
const auth = vi.hoisted(() => ({ role: "ROLE_VIEWER" }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: auth.role, email: "u@example.com" } }) }));

import CasesPage from "../page";

beforeEach(() => {
  navHolder.current.setUrl("/cases");
  get.mockReset().mockResolvedValue([]);
  getWithHeaders.mockReset().mockResolvedValue({ data: [], headers: new Headers({ "X-Total-Count": "0" }) });
});

const rendered = async (role: string) => {
  auth.role = role;
  render(<CasesPage />);
  await waitFor(() => expect(getWithHeaders).toHaveBeenCalled());
};

describe("cases page bulk downloads by role", () => {
  it("offers neither download to a VIEWER", async () => {
    await rendered("ROLE_VIEWER");
    expect(screen.queryByRole("button", { name: /export cases csv/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /export audit csv/i })).not.toBeInTheDocument();
  });

  it("offers the cases CSV, not the audit ledger, to a CASE_MANAGER", async () => {
    await rendered("ROLE_CASE_MANAGER");
    expect(screen.getByRole("button", { name: /export cases csv/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /export audit csv/i })).not.toBeInTheDocument();
  });

  it("offers both to an ADMIN", async () => {
    await rendered("ROLE_ADMIN");
    expect(screen.getByRole("button", { name: /export cases csv/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export audit csv/i })).toBeInTheDocument();
  });
});
