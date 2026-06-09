"use client";

import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "workwell-theme";
const EVENT = "workwell-theme-change";

/**
 * Applies a theme to <html> by setting BOTH the `.dark` class and the
 * `data-theme` attribute — @mieweb/ui dark mode needs both (the Tailwind
 * `@custom-variant dark` and the brand CSS `[data-theme=dark]` blocks) — then
 * persists it and notifies subscribers in the same tab.
 */
export function applyTheme(t: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", t === "dark");
  root.setAttribute("data-theme", t);
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* localStorage unavailable — ignore */
  }
  window.dispatchEvent(new Event(EVENT));
}

/**
 * Resolves the saved (or system) theme. Call once on first client load
 * (see ThemeInitializer) to apply the persisted preference before paint.
 */
export function resolveInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function getSnapshot(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

function getServerSnapshot(): Theme {
  return "light";
}

/**
 * Reads the current theme from the DOM (the source of truth, set by
 * {@link applyTheme}) via useSyncExternalStore — SSR-safe and free of
 * setState-in-effect. `setTheme`/`toggle` mutate the DOM and persist.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setTheme = useCallback((t: Theme) => applyTheme(t), []);
  const toggle = useCallback(
    () => applyTheme(getSnapshot() === "dark" ? "light" : "dark"),
    [],
  );
  return { theme, setTheme, toggle } as const;
}
