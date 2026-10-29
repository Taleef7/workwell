import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { API_BASE, MAUI_ACCOUNTS, MAUI_PASSWORD, WRITES_SKIP_REASON, expectNoErrorPage, homeFor, loginAs, writesAllowed } from "./helpers";

/**
 * An MCP client connecting over OAuth, end to end through the web app (MCP 2026-07-28 authorization).
 *
 * The route tests (`backend-ts/src/routes/oauth.test.ts`) drive the protocol; what only a browser shows is
 * the part a person does: the client's authorize link lands on the consent page through sign-in, the page
 * says who is asking and where the approval goes, Approve sends the browser to the client with a code, and
 * an admin's Revoke in Admin → MCP access ends the connection. Nothing listens on the client's loopback
 * port, so the browser's trip there is caught (`catchCallback`) and the code read from its URL, as
 * `mcp-remote` or Claude Code would.
 *
 * A WRITE spec (`maui-writes`): every test creates a client grant and audit events on the stack.
 */
test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
  test.skip(!writesAllowed(), WRITES_SKIP_REASON);
});

const RESOURCE = `${API_BASE}/mcp`;
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Dynamic Client Registration, as `mcp-remote` does it: a loopback redirect and a name of its choosing. */
async function register(request: APIRequestContext, name: string, callback: string): Promise<string> {
  const res = await request.post(`${API_BASE}/oauth/register`, { data: { client_name: name, redirect_uris: [callback] } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeUrl(clientId: string, challenge: string, callback: string, state: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "mcp",
    state,
  });
  return `${API_BASE}/oauth/authorize?${p}`;
}

/**
 * The browser's trip to the client's redirect, caught before it tries to load a page nobody serves. The
 * pending URL is returned inside an object: an async function that returned the promise itself would adopt
 * it, and awaiting the setup would wait for the callback that only comes later.
 */
async function catchCallback(page: Page, callback: string): Promise<{ reached: Promise<URL> }> {
  let reach: (url: URL) => void = () => {};
  const reached = new Promise<URL>((resolve) => (reach = resolve));
  await page.route(`${new URL(callback).origin}/**`, async (route) => {
    reach(new URL(route.request().url()));
    await route.fulfill({ status: 200, contentType: "text/html", body: "<p>MCP client callback</p>" });
  });
  return { reached };
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(MAUI_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
}

/** A 2026-07-28 request to `/mcp`, as the SDK clients send it. */
function mcp(request: APIRequestContext, token: string, method: string, params: Record<string, unknown> = {}) {
  const name = typeof params.name === "string" ? params.name : undefined;
  return request.post(RESOURCE, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
    },
    data: { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } },
  });
}

async function exchange(request: APIRequestContext, form: Record<string, string>) {
  return request.post(`${API_BASE}/oauth/token`, { form });
}

test.describe("MCP over OAuth", () => {
  test.describe.configure({ mode: "serial" });

  test("discovery: the 401 from /mcp names the metadata, and the metadata names this server", async ({ request }) => {
    const unauthorized = await request.post(RESOURCE, { data: {} });
    expect(unauthorized.status()).toBe(401);
    expect(unauthorized.headers()["www-authenticate"]).toContain(`resource_metadata="${API_BASE}/.well-known/oauth-protected-resource/mcp"`);

    const prm = (await (await request.get(`${API_BASE}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers).toEqual([API_BASE]);

    const as = (await (await request.get(`${API_BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(API_BASE);
    expect(as.authorization_endpoint).toBe(`${API_BASE}/oauth/authorize`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  });

  test("a case manager connects a client through sign-in and the consent page; it works on /mcp until an admin revokes it", async ({ page, browser, request }) => {
    const callback = "http://127.0.0.1:47123/callback";
    const name = `E2E MCP client ${Date.now()}`;
    const clientId = await register(request, name, callback);
    const { verifier, challenge } = pkce();
    const { reached } = await catchCallback(page, callback);

    // Signed out: the authorize link goes through sign-in and comes back to the consent page.
    await page.goto(authorizeUrl(clientId, challenge, callback, "st-approve"));
    await expect(page).toHaveURL(/\/login\?next=%2Foauth%2Fconsent/, { timeout: 15_000 });
    await signIn(page, MAUI_ACCOUNTS.qualityLead.email);
    await expect(page).toHaveURL(/\/oauth\/consent\?request=/, { timeout: 15_000 });

    // What the page states, from the server's reading of the signed request.
    await expect(page.getByRole("heading", { name: `Connect ${name} to WorkWell?` })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("consent-identity")).toContainText(/self-registered client/i);
    await expect(page.getByTestId("consent-redirect")).toHaveText("http://127.0.0.1:47123");
    await expect(page.getByTestId("consent-loopback-warning")).toBeVisible();
    await expect(page.getByText(MAUI_ACCOUNTS.qualityLead.email)).toBeVisible();
    await expectNoErrorPage(page);

    await page.getByRole("button", { name: "Approve" }).click();
    const back = await reached;
    expect(back.origin + back.pathname).toBe(callback);
    expect(back.searchParams.get("state")).toBe("st-approve");
    expect(back.searchParams.get("iss")).toBe(API_BASE);
    const code = back.searchParams.get("code");
    expect(code, "the approval carries a code").toBeTruthy();

    // The client's side: code → tokens → the read-only tools.
    const tokenRes = await exchange(request, { grant_type: "authorization_code", code: code!, redirect_uri: callback, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
    expect(tokenRes.status(), await tokenRes.text()).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
    expect(tokens.token_type).toBe("Bearer");

    const list = await mcp(request, tokens.access_token, "tools/list");
    expect(list.status(), await list.text()).toBe(200);
    const tools = ((await list.json()) as { result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> } }).result.tools;
    expect(tools.length).toBeGreaterThanOrEqual(10);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true), "every tool is read-only").toBe(true);
    const called = await mcp(request, tokens.access_token, "tools/call", { name: "list_measures", arguments: {} });
    expect(called.status(), await called.text()).toBe(200);
    expect(((await called.json()) as { result: { isError?: boolean } }).result.isError ?? false).toBe(false);

    // The code is spent; the tokens refresh and rotate.
    // A replay must pass every other check (client, redirect, verifier) to reach the reuse rule.
    const replay = await exchange(request, { grant_type: "authorization_code", code: code!, redirect_uri: callback, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
    expect(replay.status()).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
    // The replay revoked the grant (RFC 6749 §4.1.2), so this connection is over: connect a second one for the rest.
    expect((await mcp(request, tokens.access_token, "tools/list")).status()).toBe(401);

    const second = pkce();
    const { reached: reachedAgain } = await catchCallback(page, callback);
    await page.goto(authorizeUrl(clientId, second.challenge, callback, "st-again"));
    await expect(page.getByRole("heading", { name: `Connect ${name} to WorkWell?` })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Approve" }).click();
    const code2 = (await reachedAgain).searchParams.get("code")!;
    const t2 = (await (await exchange(request, { grant_type: "authorization_code", code: code2, redirect_uri: callback, client_id: clientId, code_verifier: second.verifier })).json()) as { access_token: string; refresh_token: string };
    const refreshed = await exchange(request, { grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: clientId });
    expect(refreshed.status(), await refreshed.text()).toBe(200);
    const t3 = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(t3.refresh_token).not.toBe(t2.refresh_token);
    expect((await mcp(request, t3.access_token, "tools/list")).status()).toBe(200);

    // An admin sees the connected client in Admin → MCP access and revokes it; its token stops at once.
    const adminContext = await browser.newContext();
    try {
      const admin = await adminContext.newPage();
      await loginAs(admin, MAUI_ACCOUNTS.admin.email);
      await admin.goto("/admin");
      await admin.getByRole("tab", { name: "MCP access" }).click();
      // This client has two grants by now: the first, revoked by the replay above, and the live second.
      const rows = admin.getByTestId("mcp-token-list").getByRole("listitem").filter({ hasText: name });
      const live = rows.filter({ hasText: "active" });
      await expect(live).toHaveCount(1, { timeout: 15_000 });
      await expect(live).toContainText("connected client (OAuth)");
      await expect(rows.filter({ hasText: "revoked" })).toHaveCount(1);
      await live.getByRole("button", { name: `Revoke ${name}` }).click();
      await admin.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
      await expect(live).toHaveCount(0, { timeout: 15_000 });
      await expect(rows.filter({ hasText: "revoked" })).toHaveCount(2);
    } finally {
      await adminContext.close();
    }
    expect((await mcp(request, t3.access_token, "tools/list")).status()).toBe(401);
  });

  test("a viewer can read the consent page but only decline, and the client hears access_denied", async ({ page, request }) => {
    const callback = "http://127.0.0.1:47124/callback";
    const name = `E2E declined client ${Date.now()}`;
    const clientId = await register(request, name, callback);
    const { challenge } = pkce();
    const { reached } = await catchCallback(page, callback);

    await page.goto(authorizeUrl(clientId, challenge, callback, "st-decline"));
    await signIn(page, MAUI_ACCOUNTS.clinician.email);
    await expect(page.getByRole("heading", { name: `Connect ${name} to WorkWell?` })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/only a case manager or admin can connect/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);

    await page.getByRole("button", { name: "Decline" }).click();
    const back = await reached;
    expect(back.origin + back.pathname).toBe(callback);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("st-decline");
    expect(back.searchParams.has("code")).toBe(false);
  });

  test("sign-in returns only to the consent page: an off-site next stays in the app", async ({ page }) => {
    for (const next of ["/.//evil.example", "//evil.example", "/\\evil.example", "https://evil.example/"]) {
      await page.context().clearCookies();
      await page.goto("/login");
      await page.evaluate(() => localStorage.clear());
      await page.goto(`/login?next=${encodeURIComponent(next)}`);
      await signIn(page, MAUI_ACCOUNTS.qualityLead.email);
      await expect(page, next).toHaveURL(homeFor(MAUI_ACCOUNTS.qualityLead.email), { timeout: 15_000 });
      expect(new URL(page.url()).hostname, next).not.toBe("evil.example");
    }
  });
});
