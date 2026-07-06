"use client";

import { useState } from "react";

export interface PanelCache<T> {
  /** Cached value for a query signature, or undefined if never fetched this session. */
  read(key: string): T | undefined;
  /** Store a freshly-fetched result under its query signature. */
  write(key: string, value: T): void;
  has(key: string): boolean;
  /** Drop everything — used when a recompute (ww:run-complete) makes cached data stale. */
  clear(): void;
}

/**
 * UX-3 — session-scoped, in-memory optimistic cache for the `/compliance` roster. Keyed by the full
 * query signature (panel + system + segment + site + status + search + page + pageSize), so switching
 * a panel/filter — or switching *back* to a previously-loaded one — renders instantly from memory
 * instead of re-paying the (cold, ~12s) roster fetch and re-showing a blank skeleton. It intentionally
 * does NOT persist across a page unmount / employee change (a plain component-lifetime ref), so it
 * never leaks stale data across sessions or unauthorized state.
 *
 * The returned API object is reference-stable across re-renders (backed by a ref), so pages can safely
 * add it to a `useCallback`/`useEffect` dep list without churning the load callback every render.
 */
export function usePanelCache<T>(): PanelCache<T> {
  // Lazy useState initializer: builds the Map + its API object exactly once and returns the SAME
  // reference on every render (so pages can add it to a useCallback/useEffect dep list without churn).
  // useState (not useRef) keeps it readable during render without tripping react-hooks/refs.
  const [api] = useState<PanelCache<T>>(() => {
    const map = new Map<string, T>();
    return {
      read: (key) => map.get(key),
      write: (key, value) => {
        map.set(key, value);
      },
      has: (key) => map.has(key),
      clear: () => map.clear(),
    };
  });
  return api;
}
