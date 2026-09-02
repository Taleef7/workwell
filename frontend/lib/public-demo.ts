/**
 * Build-time flag for public-demo affordances: "on" (default) or "off" (the Maui pilot).
 * When off, public sandbox shortcuts, walkthrough videos, and GitHub repo links are suppressed.
 */
const raw = process.env.NEXT_PUBLIC_PUBLIC_DEMO;
export const PUBLIC_DEMO: boolean = raw !== "off";
