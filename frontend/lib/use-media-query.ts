"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether a CSS media query matches, for the few places a component must render something in ONE
 * layout rather than hide a copy with CSS (#700): a panel with form state, or a region whose duplicate
 * would give tests and assistive tech two of it.
 *
 * `@mieweb/ui`'s `useMediaQuery` reads `window.matchMedia` in its initial state, which throws where
 * matchMedia is absent (jsdom) and disagrees with the server's `false` on a phone's first render (a
 * hydration mismatch). This one uses `useSyncExternalStore` with a server snapshot of `false` and
 * treats a missing matchMedia as "no match", so the desktop layout is the default everywhere.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** Below Tailwind's `md` (48rem), where the app switches to its phone layouts. */
export const BELOW_MD = "not all and (min-width: 48rem)";
