import React from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import SandboxPage from "../page";

const mockReplace = vi.fn();
const mockLogin = vi.fn();

const authState: {
  token: string | null;
  user: { email: string; role: string } | null;
} = {
  token: null,
  user: null
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace })
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    token: authState.token,
    user: authState.user,
    login: mockLogin,
    logout: vi.fn()
  })
}));

describe("SandboxPage", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockLogin.mockClear();
    authState.token = null;
    authState.user = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("auto-signs in as the read-only viewer and redirects to /programs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "tok", email: "viewer@workwell.dev", role: "ROLE_VIEWER" })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SandboxPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // the sandbox must sign in with the read-only viewer account, not a write-capable role
    const options = fetchMock.mock.calls[0]?.[1] as { body: string };
    expect(options.body).toContain("viewer@workwell.dev");
    expect(mockLogin).toHaveBeenCalledWith("tok", "viewer@workwell.dev", "ROLE_VIEWER");
    expect(mockReplace).toHaveBeenCalledWith("/programs");
  });
});
