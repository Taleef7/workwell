"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Brands shipped by @mieweb/ui (served from /brands/{value}.css). */
export const BRANDS = [
  { value: "enterprise-health", label: "Enterprise Health" },
  { value: "mieweb", label: "MIE Web" },
  { value: "bluehive", label: "BlueHive Health" },
  { value: "webchart", label: "WebChart" },
  { value: "ozwell", label: "Ozwell AI" },
  { value: "waggleline", label: "WaggleLine" },
] as const;

export type BrandId = (typeof BRANDS)[number]["value"];

export const DEFAULT_BRAND: BrandId = "enterprise-health";

const STORAGE_KEY = "workwell-brand";
const EVENT = "workwell-brand-change";
const LINK_ID = "mieweb-brand-css";

/**
 * Swaps the active brand by injecting/updating a <link> to /brands/{brand}.css
 * (the dynamically-loaded sheet overrides the static default from globals.css),
 * records it on <html data-brand> for snapshot reads, and persists it.
 */
export function applyBrand(brand: BrandId) {
  let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = LINK_ID;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  link.href = `/brands/${brand}.css`;
  document.documentElement.setAttribute("data-brand", brand);
  try {
    localStorage.setItem(STORAGE_KEY, brand);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Resolves the saved brand (or the default). Call once on first client load. */
export function resolveInitialBrand(): BrandId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && BRANDS.some((b) => b.value === saved)) return saved as BrandId;
  } catch {
    /* ignore */
  }
  return DEFAULT_BRAND;
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function getSnapshot(): BrandId {
  const b = document.documentElement.getAttribute("data-brand");
  return b && BRANDS.some((x) => x.value === b) ? (b as BrandId) : DEFAULT_BRAND;
}

function getServerSnapshot(): BrandId {
  return DEFAULT_BRAND;
}

export function useBrand() {
  const brand = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setBrand = useCallback((b: BrandId) => applyBrand(b), []);
  return { brand, setBrand, brands: BRANDS } as const;
}
