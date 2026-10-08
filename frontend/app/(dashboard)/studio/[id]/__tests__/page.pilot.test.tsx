import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StudioMeasurePage from "../page";
import { ROUTED_IDENTITIES } from "@/test/fixtures/scoring-logic";

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

const measureHolder: { current: Record<string, unknown> } = {
  current: { id: "cms125", name: "Breast Cancer Screening", version: "1.0", status: "Active" },
};
vi.mock("@/features/studio/hooks/useMeasureDetail", () => ({
  useMeasureDetail: () => ({
    measure: measureHolder.current,
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

describe("StudioMeasurePage names what runs apart from the authoring record (#769)", () => {
  const RECORD = { id: "cms125", name: "Breast Cancer Screening", version: "v1.0", status: "Active" };
  beforeEach(() => {
    setPublicDemo(false);
    currentRole = "ROLE_ADMIN";
  });

  it("an officially routed measure keeps its record version and adds a 'Runs:' line", () => {
    measureHolder.current = { ...RECORD, identity: ROUTED_IDENTITIES.cms125 };
    render(<StudioMeasurePage />);
    expect(screen.getByText(/^v1\.0 •/)).toBeInTheDocument();
    expect(screen.getByTestId("studio-runs").textContent).toBe("Runs: CMS125FHIR v1.0.000 (CMS draft)");
    expect(screen.queryByTestId("studio-translation")).toBeNull();
  });

  it("with a translation routed beside it, names the year the translation scores", () => {
    measureHolder.current = {
      ...RECORD,
      id: "cms137",
      identity: {
        ...ROUTED_IDENTITIES.cms137,
        translation: { label: "WorkWell translation of CMS137v15", version: "ww-2027.1", url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15", year: "2027" },
      },
    };
    render(<StudioMeasurePage />);
    expect(screen.getByTestId("studio-runs").textContent).toBe("Runs: CMS137FHIR v1.0.000 (CMS draft)");
    expect(screen.getByTestId("studio-translation").textContent).toBe(
      "For 2027: WorkWell translation of CMS137v15 (ww-2027.1), not a CMS measure",
    );
  });

  it("an authored measure (no identity, or no executed logic) shows no 'Runs:' line", () => {
    measureHolder.current = { ...RECORD, identity: { cmsId: "CMS125", mipsQualityId: "112" } };
    const { unmount } = render(<StudioMeasurePage />);
    expect(screen.queryByTestId("studio-runs")).toBeNull();
    unmount();
    measureHolder.current = { ...RECORD, id: "audiogram", name: "Annual Audiogram Completed", identity: null };
    render(<StudioMeasurePage />);
    expect(screen.queryByTestId("studio-runs")).toBeNull();
  });
});
