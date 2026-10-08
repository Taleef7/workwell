import { test, expect } from "@playwright/test";
import { MAUI_ACCOUNTS, loginAs, expectNoErrorPage } from "./helpers";

/**
 * A case a WorkWell translation scored is labelled as the translation on the page staff open (#769).
 *
 * The sandbox has no 2027 run and must not get one (a 2027 run closes and reopens every 2026 case,
 * #654), so CI's e2e-maui job creates the case on its throwaway stack with a one-patient manual run in
 * the translation's year and passes its id here. Anywhere else this skips.
 */
const caseId = process.env.TRANSLATED_CASE_ID;
const label = process.env.TRANSLATED_CASE_LABEL;

test("a translated case names the translation, never CMS's artifact", async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
  test.skip(!caseId || !label, "set by CI after it opens a translated case");
  await loginAs(page, MAUI_ACCOUNTS.admin.email);
  await page.goto(`/cases/${caseId}`);
  await expectNoErrorPage(page);
  // The measure line above the patient's name: the full form, "MIPS 305 · WorkWell translation of … (ww-…)".
  const escaped = label!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const badge = page.getByText(new RegExp(`^MIPS \\d+ · ${escaped} \\(`)).first();
  await expect(badge).toBeVisible({ timeout: 20_000 });
  await expect(badge).not.toContainText("FHIR");
});
