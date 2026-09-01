import { renderHook, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMeasureIdentities } from "./measure-identity";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({
  useApi: () => apiMock,
}));

describe("useMeasureIdentities hook", () => {
  beforeEach(() => {
    get.mockReset();
  });

  it("fetches /api/measures once on mount and labelFor returns crosswalk label for cms125 and plain name for audiogram", async () => {
    get.mockResolvedValue([
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

    const { result } = renderHook(() => useMeasureIdentities());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/measures");

    expect(result.current.labelFor("cms125", "Breast Cancer Screening")).toBe(
      "MIPS 112 · CMS125 · Breast Cancer Screening"
    );
    expect(result.current.labelFor("audiogram", "Annual Audiogram Completed")).toBe(
      "Annual Audiogram Completed"
    );
    expect(result.current.labelFor("unknown", "Unknown Measure")).toBe(
      "Unknown Measure"
    );
  });

  it("on fetch error existing identities are kept and error is set", async () => {
    get.mockResolvedValueOnce([
      {
        id: "cms125",
        name: "Breast Cancer Screening",
        identity: { cmsId: "CMS125", mipsQualityId: "112" },
      },
    ]);

    const { result } = renderHook(() => useMeasureIdentities());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.labelFor("cms125", "Breast Cancer Screening")).toBe(
      "MIPS 112 · CMS125 · Breast Cancer Screening"
    );
    expect(result.current.error).toBeNull();

    // Now trigger an error on refetch
    get.mockRejectedValueOnce(new Error("Network connection failed"));

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("Network connection failed");
    // Existing identities are kept:
    expect(result.current.labelFor("cms125", "Breast Cancer Screening")).toBe(
      "MIPS 112 · CMS125 · Breast Cancer Screening"
    );
  });

  it("a stale earlier response does not overwrite a later one", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;

    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const secondPromise = new Promise((resolve) => {
      resolveSecond = resolve;
    });

    get.mockReturnValueOnce(firstPromise).mockReturnValueOnce(secondPromise);

    const { result } = renderHook(() => useMeasureIdentities());

    // Trigger second request before first finishes
    let refetchPromise: Promise<void> | undefined;
    act(() => {
      refetchPromise = result.current.refetch();
    });

    // Resolve second request first with newer data
    await act(async () => {
      resolveSecond([
        {
          id: "cms125",
          name: "Breast Cancer Screening",
          identity: { cmsId: "CMS125", mipsQualityId: "112" },
        },
      ]);
      await refetchPromise;
    });

    expect(result.current.labelFor("cms125", "Breast Cancer Screening")).toBe(
      "MIPS 112 · CMS125 · Breast Cancer Screening"
    );

    // Now resolve first request with older data (e.g. empty or different)
    await act(async () => {
      resolveFirst([]);
    });

    // Verify older response did NOT overwrite newer data
    expect(result.current.labelFor("cms125", "Breast Cancer Screening")).toBe(
      "MIPS 112 · CMS125 · Breast Cancer Screening"
    );
  });
});
