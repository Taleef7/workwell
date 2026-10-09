import { test, expect } from "@playwright/test";
import { MAUI_ACCOUNTS, loginAs, expectNoErrorPage } from "./helpers";

/**
 * A case a WorkWell translation scored is labelled as the translation on the page staff open (#769).
 *
 * The sandbox has no 2027 run and must not get one (a 2027 run closes and reopens every 2026 case,
 * #654), so CI's e2e-maui job creates one case per routed translation on its throwaway stack, each with a
 * one-patient manual run in the translation's year, and passes them here as one JSON list (#779: a
 * variable written per translation kept only the last). Anywhere else this skips.
 */
interface TranslatedCase {
  caseId: string;
  label: string;
}

const cases: TranslatedCase[] = process.env.TRANSLATED_CASES ? (JSON.parse(process.env.TRANSLATED_CASES) as TranslatedCase[]) : [];
const expected = (process.env.TRANSLATED_CASES_EXPECTED ?? "").split(",").filter(Boolean);

test("CI handed over one translated case per routed translation", () => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
  test.skip(!process.env.TRANSLATED_CASES, "set by CI after it opens the translated cases");
  expect(cases.length).toBe(expected.length);
});

for (const { caseId, label } of cases) {
  test(`a translated case names the translation, never CMS's artifact: ${label}`, async ({ page }) => {
    test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
    await loginAs(page, MAUI_ACCOUNTS.admin.email);
    await page.goto(`/cases/${caseId}`);
    await expectNoErrorPage(page);
    // The measure line above the patient's name: the full form, "MIPS 113 · WorkWell translation of … (ww-…)".
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const badge = page.getByText(new RegExp(`^MIPS \\d+ · ${escaped} \\(`)).first();
    await expect(badge).toBeVisible({ timeout: 20_000 });
    await expect(badge).not.toContainText("FHIR");
  });
}
