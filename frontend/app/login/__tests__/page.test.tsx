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
});
