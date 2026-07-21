import { test, expect, type Page } from "@playwright/test";
import { ADMIN_EMAIL, loginAs, expectNoErrorPage } from "./helpers";

const STUDIO_TABS = ["Spec", "CQL", "Rule Builder", "Value Sets", "Tests"];

async function gotoStudio(page: Page) {
  await loginAs(page, ADMIN_EMAIL);
  await page.goto("/studio/audiogram");
  await expect(page.getByRole("tab", { name: "Spec" })).toBeVisible({ timeout: 20_000 });
}

test.describe("Studio authoring tabs", () => {
  test("Spec / CQL / Rule Builder / Value Sets / Tests tabs all render", async ({ page }) => {
    await gotoStudio(page);
    for (const tabName of STUDIO_TABS) {
      const tab = page.getByRole("tab", { name: tabName, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel")).toBeVisible({ timeout: 20_000 });
      await expectNoErrorPage(page);
    }
  });

  test("Value Sets tab: Codify 'Find a code' search returns results and prefills the form", async ({ page }) => {
    test.setTimeout(180_000); // the Codify index shards download from ui.mieweb.org on first load
    await gotoStudio(page);
    await page.getByRole("tab", { name: "Value Sets", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Find a code \(Codify\)/i })).toBeVisible({ timeout: 20_000 });

    const search = page.getByRole("combobox", { name: "Search medical codes" });
    await expect(search).toBeVisible({ timeout: 20_000 });

    // Wait for the offline index to finish loading — either ready or the error state.
    const ready = page.getByText(/Offline index ready|results in .* ms/);
    const errorState = page.getByText(/Index unavailable/);
    await expect(ready.or(errorState).first()).toBeVisible({ timeout: 120_000 });

    if (await errorState.isVisible()) {
      // External index unreachable: the control must degrade to an error state with a Retry
      // affordance (never a hang). Report which branch ran via an annotation.
      test.info().annotations.push({
        type: "codify-index-unreachable",
        description: "ui.mieweb.org/codify was unreachable — asserted error state + Retry instead of search results",
      });
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(search).toBeDisabled();
      return;
    }

    await search.fill("breast cancer screening");
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible({ timeout: 30_000 });
    expect(await options.count()).toBeGreaterThan(0);

    // Picking a result prefills the create-value-set form (name + LOCAL urn:workwell:codify OID).
    const firstOption = options.first();
    const optionLabel = (await firstOption.textContent())?.trim() ?? "";
    await firstOption.click();
    await expect(page.getByText(/^Picked:/).first()).toBeVisible({ timeout: 10_000 });
    const nameValue = await page.getByPlaceholder("Name", { exact: true }).inputValue();
    const oidValue = await page.getByPlaceholder(/^OID/).inputValue();
    expect(nameValue.length).toBeGreaterThan(0);
    expect(oidValue).toMatch(/^urn:workwell:codify:/);
    test.info().annotations.push({
      type: "codify-picked",
      description: `picked "${optionLabel.slice(0, 80)}" → name="${nameValue}" oid="${oidValue}"`,
    });
  });
});
