import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "../page";

const mockReplace = vi.fn();
const mockLogin = vi.fn();

const authState: {
  token: string | null;
  user: { email: string; role: string } | null;
} = {
  token: null,
  user: null,
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    token: authState.token,
    user: authState.user,
    login: mockLogin,
  }),
}));

describe("LoginPage", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockLogin.mockClear();
    authState.token = null;
    authState.user = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs(); // the demo-mode guard stubs NEXT_PUBLIC_DEMO_MODE — never let it leak
  });

  it("posts login with credentials included so refresh cookie can be persisted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "tok", email: "admin@workwell.dev", role: "ROLE_ADMIN" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "admin@workwell.dev");
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "Workwell123!");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/auth/login");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
    });
    expect(mockLogin).toHaveBeenCalledWith("tok", "admin@workwell.dev", "ROLE_ADMIN");
  });

  // Security regression guard: with demo mode off (the production build — NEXT_PUBLIC_DEMO_MODE=true
  // fails the prod build), the login page must NOT advertise the admin demo credential. Previously the
  // "Fill demo credentials" button and the "Demo: admin@workwell.dev" hint rendered unconditionally,
  // leaking a one-click admin login onto the public production site.
  //
  // demoMode is captured at module import, so force the env OFF and re-import a fresh module rather
  // than relying on the caller's NEXT_PUBLIC_DEMO_MODE (Codex P2: the test must pass even when the
  // suite is run in the supported local `NEXT_PUBLIC_DEMO_MODE=true` configuration).
  it("does not expose the admin demo credential when demo mode is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "");
    vi.resetModules();
    const { default: FreshLoginPage } = await import("../page");
    render(<FreshLoginPage />);
    expect(screen.queryByText(/fill demo credentials/i)).toBeNull();
    expect(screen.queryByText(/admin@workwell\.dev/i)).toBeNull();
    expect(screen.queryByText(/^Demo:/)).toBeNull();
    // The read-only public sandbox link stays — it is safe (ROLE_VIEWER, blocked from all writes).
    expect(screen.getByRole("link", { name: /open public sandbox/i })).toBeTruthy();
  });

  // The complementary direction: with demo mode ON, the controls DO appear (so the guard above is
  // proving a real conditional, not just that the strings never render).
  it("shows the demo credential controls when demo mode is on", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    vi.resetModules();
    const { default: FreshLoginPage } = await import("../page");
    render(<FreshLoginPage />);
    expect(screen.getByRole("button", { name: /fill demo credentials/i })).toBeTruthy();
    expect(screen.getByText(/admin@workwell\.dev/i)).toBeTruthy();
  });
});
