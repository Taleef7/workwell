import { test, expect } from "@playwright/test";
import { API_BASE, MAUI_ACCOUNTS, expectNoErrorPage, getAuthToken, loginAs } from "./helpers";
import { BASE_URL, isLocalStack } from "../../base-url";

/**
 * An attributed list, end to end (#874): import one, then chase its gaps on the work list, the roster
 * and Cases, and compute its report.
 *
 * **A LOCAL stack only, whatever `PLAYWRIGHT_ALLOW_WRITES` says.** Every other write spec restores what
 * it touched; this one cannot. Lists are immutable and there is no DELETE, so an import is permanent,
 * and a run against the deployed sandbox would leave an e2e list in the picker the pilot group uses.
 * `writesAllowed()` admits a deployed stack when asked by name; this spec does not. The check is on
 * hostnames: a local API pointed at a deployed database passes it, and nothing the stack serves tells
 * the two apart, so never run it that way.
 *
 * The list's members are read off the stack (four patients with open gaps), never hard-coded, so the
 * spec holds on any corpus and never trips the sandbox's namespace gate.
 */
test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
  test.skip(
    !(isLocalStack(BASE_URL) && isLocalStack(API_BASE)),
    `an import cannot be undone, so this spec runs only against a local stack (web ${BASE_URL}, api ${API_BASE})`,
  );
});

test("a list chosen on each screen narrows it to the list's members, and its report answers", async ({ page, request }) => {
  const token = await getAuthToken(request);
  const headers = { authorization: `Bearer ${token}` };

  const open = await request.get(`${API_BASE}/api/worklist/patients?status=open&limit=4&offset=0`, { headers });
  expect(open.status()).toBe(200);
  const members: string[] = ((await open.json()) as Array<{ employeeId: string }>).map((row) => row.employeeId);
  expect(members.length, "the corpus needs at least one patient with an open gap").toBeGreaterThan(0);

  const name = `e2e attributed list ${Date.now()}`;
  const imported = await request.post(`${API_BASE}/api/subject-lists`, {
    headers,
    data: { name, source: "e2e", identifiers: members },
  });
  expect(imported.status()).toBe(201);
  const { list, counts } = (await imported.json()) as { list: { id: string }; counts: { matched: number } };
  expect(counts.matched).toBe(members.length);

  await loginAs(page, MAUI_ACCOUNTS.qualityLead.email);

  // The work list: chosen in the picker, written to the URL, and every row a member.
  await page.goto("/worklist?panel=all");
  await page.getByRole("combobox", { name: "Attributed list" }).click();
  await page.getByRole("option", { name: new RegExp(`^${name} · `) }).click();
  await expect(page).toHaveURL(new RegExp(`listId=${list.id}`));
  await expect(page.getByText(`Attributed list: ${name}`)).toBeVisible();
  const ids = page.getByTestId("worklist-patient-id");
  await expect(ids.first()).toBeVisible({ timeout: 20_000 });
  for (const id of await ids.allInnerTexts()) expect(members).toContain(id.trim());
  await expectNoErrorPage(page);

  // The roster: the request names the list, and every row it returns is a member.
  const rosterResponse = page.waitForResponse(
    (res) => res.url().includes("/api/compliance/roster?") && res.url().includes(`listId=${list.id}`),
  );
  await page.goto(`/compliance?listId=${list.id}`);
  const roster = (await (await rosterResponse).json()) as { rows: Array<{ subject: { externalId: string } }> };
  expect(roster.rows.length).toBeGreaterThan(0);
  for (const row of roster.rows) expect(members).toContain(row.subject.externalId);
  await expect(page.getByText(`Attributed list: ${name}`)).toBeVisible();

  // Cases: the CSV is the screen's own query, so the export carries the list.
  await page.goto(`/cases?listId=${list.id}`);
  const exportRequest = page.waitForRequest((req) => req.url().includes("/api/exports/cases?"));
  await page.getByRole("button", { name: /Export cases CSV/i }).click();
  expect((await exportRequest).url()).toContain(`listId=${list.id}`);

  // The report: it answers (a table or a stated "no run"), never a timeout or a refusal.
  await page.goto("/lists");
  await page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "Open" }).click();
  await page.getByRole("button", { name: "Compute" }).click();
  await expect(page.getByRole("region", { name: "Measurement-year report table" })).toBeVisible({ timeout: 30_000 });
  await expectNoErrorPage(page);
});
