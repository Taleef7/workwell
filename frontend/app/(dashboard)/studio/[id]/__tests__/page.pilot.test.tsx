import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StudioMeasurePage from "../page";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

let currentRole = "ROLE_CASE_MANAGER";
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: currentRole } }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "cms125" }),
}));

const apiGet = vi.fn();
vi.mock("@/lib/api/hooks", () => ({
  useApi: () => ({ get: apiGet, post: vi.fn() }),
}));

const loadDetailMock = vi.fn();
const loadValueSetsMock = vi.fn();
const loadOshaReferencesMock = vi.fn();

vi.mock("@/features/studio/hooks/useMeasureDetail", () => ({
  useMeasureDetail: () => ({
    measure: { id: "cms125", name: "Breast Cancer Screening", version: "1.0", status: "Active" },
    activationReadiness: null,
    versionHistory: [],
    loading: false,
    error: null,
    setError: vi.fn(),
    load: loadDetailMock,
  }),
}));

vi.mock("@/features/studio/hooks/useValueSets", () => ({
  useValueSets: () => ({ allValueSets: [], load: loadValueSetsMock }),
}));

vi.mock("@/features/studio/hooks/useOshaReferences", () => ({
  useOshaReferences: () => ({ oshaReferences: [], load: loadOshaReferencesMock }),
}));

describe("StudioMeasurePage pilot mode route guard", () => {
  beforeEach(() => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";
    apiGet.mockReset().mockResolvedValue([]);
    loadDetailMock.mockClear();
    loadValueSetsMock.mockClear();
    loadOshaReferencesMock.mockClear();
  });

  it("renders access denied for non-admin in pilot mode", () => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";

    render(<StudioMeasurePage />);

    expect(screen.getByText("Studio")).toBeInTheDocument();
    expect(screen.getByText(/Your current role does not have access to this section/i)).toBeInTheDocument();
    expect(loadDetailMock).not.toHaveBeenCalled();
    expect(loadValueSetsMock).not.toHaveBeenCalled();
    expect(loadOshaReferencesMock).not.toHaveBeenCalled();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("renders measure detail for admin in pilot mode", () => {
    setPublicDemo(false);
    currentRole = "ROLE_ADMIN";

    render(<StudioMeasurePage />);

    expect(screen.queryByText(/Your current role does not have access to this section/i)).toBeNull();
    expect(screen.getByText("Breast Cancer Screening")).toBeInTheDocument();
  });

  it("companion: renders measure detail for non-admin when PUBLIC_DEMO is true", () => {
    setPublicDemo(true);
    currentRole = "ROLE_CASE_MANAGER";

    render(<StudioMeasurePage />);

    expect(screen.queryByText(/Your current role does not have access to this section/i)).toBeNull();
    expect(screen.getByText("Breast Cancer Screening")).toBeInTheDocument();
  });
});
