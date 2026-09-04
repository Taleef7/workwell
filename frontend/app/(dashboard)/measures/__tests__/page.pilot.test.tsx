import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MeasuresPage from "../page";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

let currentRole = "ROLE_CASE_MANAGER";
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: { role: currentRole },
    token: "test-token",
    logout: vi.fn(),
    updateToken: vi.fn(),
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/features/datavis/NitroGridClient", () => ({
  __esModule: true,
  default: () => <div data-testid="measures-grid" />,
}));

const mockMeasures = [
  {
    id: "m1",
    name: "Measure 1",
    policyRef: "P1",
    version: "1.0",
    status: "Active",
    owner: "Owner",
    lastUpdated: new Date().toISOString(),
    tags: [],
    statusUpdatedAt: new Date().toISOString(),
    statusUpdatedBy: "system",
    identity: null,
  },
];

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api/hooks", () => ({
  useApi: () => ({ get, post }),
}));

describe("MeasuresPage pilot mode route guard", () => {
  beforeEach(() => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";
    get.mockReset().mockResolvedValue(mockMeasures);
  });

  it("renders access denied for case manager in pilot mode", async () => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";

    render(<MeasuresPage />);

    expect(screen.getByText("Measures")).toBeInTheDocument();
    expect(
      screen.getByText(/Your current role does not have access to this section/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("measures-grid")).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("renders measures list for admin in pilot mode", async () => {
    setPublicDemo(false);
    currentRole = "ROLE_ADMIN";

    render(<MeasuresPage />);

    expect(screen.getByText("Measures")).toBeInTheDocument();
    expect(
      screen.queryByText(/Your current role does not have access to this section/i),
    ).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId("measures-grid")).toBeInTheDocument();
    });
  });

  it("companion: renders measures list for case manager when PUBLIC_DEMO is true", async () => {
    setPublicDemo(true);
    currentRole = "ROLE_CASE_MANAGER";

    render(<MeasuresPage />);

    expect(screen.getByText("Measures")).toBeInTheDocument();
    expect(
      screen.queryByText(/Your current role does not have access to this section/i),
    ).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId("measures-grid")).toBeInTheDocument();
    });
  });
});
