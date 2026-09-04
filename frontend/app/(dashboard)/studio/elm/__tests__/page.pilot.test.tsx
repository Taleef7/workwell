import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ElmExplorerPage from "../page";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

let currentRole = "ROLE_CASE_MANAGER";
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: currentRole } }),
}));

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api/hooks", () => ({
  useApi: () => ({ get, post }),
}));

describe("ElmExplorerPage pilot mode route guard", () => {
  beforeEach(() => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";
    get.mockReset().mockResolvedValue([]);
  });

  it("renders access denied for non-admin in pilot mode", () => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";

    render(<ElmExplorerPage />);

    expect(screen.getByText("ELM Explorer")).toBeInTheDocument();
    expect(screen.getByText(/Your current role does not have access to this section/i)).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("renders explorer for admin in pilot mode", async () => {
    setPublicDemo(false);
    currentRole = "ROLE_ADMIN";

    render(<ElmExplorerPage />);

    await waitFor(() => {
      expect(screen.getByText("ELM Explorer")).toBeInTheDocument();
    });

    expect(screen.queryByText(/Your current role does not have access to this section/i)).toBeNull();
  });

  it("companion: renders explorer for non-admin when PUBLIC_DEMO is true", async () => {
    setPublicDemo(true);
    currentRole = "ROLE_CASE_MANAGER";

    render(<ElmExplorerPage />);

    await waitFor(() => {
      expect(screen.getByText("ELM Explorer")).toBeInTheDocument();
    });

    expect(screen.queryByText(/Your current role does not have access to this section/i)).toBeNull();
  });
});
