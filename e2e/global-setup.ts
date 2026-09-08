import { chromium, request } from "@playwright/test";
import { AUTH_SESSIONS, ensureCompletedRun, MAUI_PASSWORD, storageStatePath } from "./tests/maui/helpers";

/**
 * Two jobs, both done ONCE for the whole suite rather than per test.
 *
 * 1. A COMPLETED ALL_PROGRAMS run must exist, or every roster/chip/case assertion is about an empty
 *    stack.
 * 2. A signed-in browser state per role. Logging in inside `beforeEach` cost the Maui project ~40
 *    sign-in round trips — the single largest fixed cost once the failing tests stopped burning their
 *    timeouts. Each spec now picks a role's storage state and starts on the page it is about.
 */
export default async function globalSetup() {
  if (process.env.PLAYWRIGHT_PROFILE !== "maui") return;

  const api = await request.newContext();
  try {
    await ensureCompletedRun(api);
  } finally {
    await api.dispose();
  }

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  const browser = await chromium.launch();
  try {
    // One sign-in per (role, spec file). Sharing ONE state across parallel workers would share one
    // refresh-token family, and presenting an already-rotated token revokes the family — so a refresh
    // on one worker would sign the others out. The clinician and quality-staff sign-ins are themselves
    // under test in auth.spec.ts, so they stay explicit there.
    for (const s of AUTH_SESSIONS) {
      const page = await browser.newPage({ baseURL });
      await page.goto("/login");
      await page.locator("#email").fill(s.email);
      await page.locator("#password").fill(MAUI_PASSWORD);
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.waitForURL(/\/programs/, { timeout: 30_000 });
      await page.context().storageState({ path: storageStatePath(s.email, s.tag) });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
