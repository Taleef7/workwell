"use client";

import { Moon, Sun } from "lucide-react";
import { Select } from "@mieweb/ui";
import { useTheme } from "@/lib/useTheme";
import { useBrand, type BrandId } from "@/lib/useBrand";

/**
 * Header control for switching the active brand (Enterprise Health default) and
 * toggling light/dark. Backed by the `useBrand` / `useTheme` hooks. Pass
 * `showBrand={false}` for tight spaces (mobile) to show only the theme toggle.
 */
export function ThemeBrandSwitcher({ showBrand = true }: { showBrand?: boolean }) {
  const { theme, toggle } = useTheme();
  const { brand, setBrand, brands } = useBrand();

  return (
    <div className="flex items-center gap-2">
      {showBrand && (
        <div className="hidden sm:block">
          <Select
            aria-label="Brand theme"
            value={brand}
            onValueChange={(value) => setBrand(value as BrandId)}
            options={brands.map((b) => ({ value: b.value, label: b.label }))}
            size="sm"
            className="w-40"
          />
        </div>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 transition hover:bg-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
    </div>
  );
}
