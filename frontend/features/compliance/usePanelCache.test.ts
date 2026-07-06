import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePanelCache } from "./usePanelCache";

describe("usePanelCache", () => {
  it("reads back a written entry by key", () => {
    const { result } = renderHook(() => usePanelCache<{ n: number }>());
    expect(result.current.has("a")).toBe(false);
    result.current.write("a", { n: 1 });
    expect(result.current.has("a")).toBe(true);
    expect(result.current.read("a")).toEqual({ n: 1 });
    expect(result.current.read("missing")).toBeUndefined();
  });

  it("keeps a stable API object across re-renders (so effect deps don't churn)", () => {
    const { result, rerender } = renderHook(() => usePanelCache<number>());
    const first = result.current;
    result.current.write("k", 7);
    rerender();
    // Same object identity — critical: the page adds the cache to a useCallback dep list.
    expect(result.current).toBe(first);
    // And the written entry survives the re-render (in-memory, session-scoped).
    expect(result.current.read("k")).toBe(7);
  });

  it("clear() empties the cache", () => {
    const { result } = renderHook(() => usePanelCache<string>());
    result.current.write("x", "v");
    result.current.clear();
    expect(result.current.has("x")).toBe(false);
  });
});
