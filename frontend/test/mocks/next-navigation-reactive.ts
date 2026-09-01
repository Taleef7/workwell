import React from "react";
import { vi } from "vitest";

/**
 * A reactive next/navigation mock: `push`/`replace` actually update the URLSearchParams and
 * notify subscribers, the way the real App Router re-renders `useSearchParams()` consumers.
 * Needed because pages derive filter state from the URL — a static params mock would make
 * every URL write-back invisible to the page under test.
 */
export function createNavMock(pathname: string) {
  const state = {
    params: new URLSearchParams(),
    listeners: new Set<() => void>(),
    history: [] as Array<{ method: "push" | "replace"; url: string }>,
  };
  function setUrl(url: string) {
    const q = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    state.params = new URLSearchParams(q);
    for (const listener of Array.from(state.listeners)) listener();
  }
  const push = vi.fn((url: string) => {
    state.history.push({ method: "push", url });
    setUrl(url);
  });
  const replace = vi.fn((url: string) => {
    state.history.push({ method: "replace", url });
    setUrl(url);
  });
  const router = {
    push,
    replace,
  };
  const navigation = {
    useSearchParams: () =>
      React.useSyncExternalStore(
        (cb: () => void) => {
          state.listeners.add(cb);
          return () => state.listeners.delete(cb);
        },
        () => state.params,
        () => state.params,
      ),
    useRouter: () => router,
    usePathname: () => pathname,
  };
  return {
    navigation,
    setUrl,
    get params() { return state.params; },
    get history() { return state.history; },
    router,
    push,
    replace,
  };
}

