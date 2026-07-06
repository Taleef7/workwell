import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLOW_LOAD_HINT, useSlowLoadHint } from "../useSlowLoadHint";

describe("useSlowLoadHint", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("stays false until the load has run past the delay", () => {
    const { result } = renderHook(() => useSlowLoadHint(true, 3000));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(2999));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(2));
    expect(result.current).toBe(true);
  });

  it("clears the hint the moment the load resolves", () => {
    const { result, rerender } = renderHook(
      ({ loading }: { loading: boolean }) => useSlowLoadHint(loading, 3000),
      { initialProps: { loading: true } }
    );
    act(() => vi.advanceTimersByTime(3100));
    expect(result.current).toBe(true);
    rerender({ loading: false });
    // The reset is deferred to a 0-timeout (lint: no sync setState in an effect) — effectively next tick.
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(false);
  });

  it("never flips to true when the load finishes before the delay", () => {
    const { result, rerender } = renderHook(
      ({ loading }: { loading: boolean }) => useSlowLoadHint(loading, 3000),
      { initialProps: { loading: true } }
    );
    act(() => vi.advanceTimersByTime(1000));
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(false);
  });

  it("exposes an honest, config-light hint constant", () => {
    expect(SLOW_LOAD_HINT).toMatch(/1\.68M/);
  });
});
