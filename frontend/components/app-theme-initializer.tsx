"use client";

import { useEffect } from "react";
import { applyTheme, resolveInitialTheme } from "@/lib/useTheme";
import { applyBrand, resolveInitialBrand } from "@/lib/useBrand";

/**
 * Restores the persisted theme + brand on first client load — must be rendered
 * in the root layout so it runs on every page (not just the settings page).
 * DOM side-effects only (no React state), so it's safe inside an effect.
 */
export function AppThemeInitializer() {
  useEffect(() => {
    applyTheme(resolveInitialTheme());
    applyBrand(resolveInitialBrand());
  }, []);

  return null;
}
