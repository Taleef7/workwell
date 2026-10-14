import { renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_RETRY_DELAYS_MS, useMeasureIdentities } from "./measure-identity";

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

  it("does not update state, trigger warnings, or throw when request resolves after unmount", async () => {
    let resolveRequest!: (value: unknown) => void;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    get.mockReturnValue(requestPromise);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = renderHook(() => useMeasureIdentities());

    // Unmount with the request still outstanding
    unmount();

    // Resolve the request after unmount
    await act(async () => {
      resolveRequest([
        {
          id: "cms125",
          name: "Breast Cancer Screening",
          identity: { cmsId: "CMS125", mipsQualityId: "112" },
        },
      ]);
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe("useMeasureIdentities — a failed first fetch is retried", () => {
  const CMS125_ROW = [{ id: "cms125", name: "Breast Cancer Screening", identity: { cmsId: "CMS125", mipsQualityId: "112" } }];

  beforeEach(() => {
    get.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a first fetch that fails (a worker still warming) is retried, and the labels get their MIPS id", async () => {
    get.mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValueOnce(CMS125_ROW);
    const { result } = renderHook(() => useMeasureIdentities());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.error).toBe("Failed to fetch");
    // Still loading: a retry is pending.
    expect(result.current.loading).toBe(true);
    expect(result.current.labelFor("cms125", "Breast Cancer Screening")).toBe("Breast Cancer Screening");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDENTITY_RETRY_DELAYS_MS[0]);
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.labelFor("cms125", "Breast Cancer Screening")).toBe("MIPS 112 · CMS125 · Breast Cancer Screening");
  });

  it("gives up after the bounded retries", async () => {
    get.mockRejectedValue(new Error("Failed to fetch"));
    const { result } = renderHook(() => useMeasureIdentities());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDENTITY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 60_000);
    });
    expect(get).toHaveBeenCalledTimes(1 + IDENTITY_RETRY_DELAYS_MS.length);
    expect(result.current.error).toBe("Failed to fetch");
    expect(result.current.loading).toBe(false);
  });

  it("once identities have loaded, a failed refetch keeps them and is not retried", async () => {
    get.mockResolvedValueOnce(CMS125_ROW).mockRejectedValue(new Error("Failed to fetch"));
    const { result } = renderHook(() => useMeasureIdentities());
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.refetch();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.labelFor("cms125", "Breast Cancer Screening")).toBe("MIPS 112 · CMS125 · Breast Cancer Screening");
  });

  it("an unmounted page schedules no further fetch", async () => {
    get.mockRejectedValue(new Error("Failed to fetch"));
    const { unmount } = renderHook(() => useMeasureIdentities());
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    // The pending retry is cancelled, not left to find the page gone.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
