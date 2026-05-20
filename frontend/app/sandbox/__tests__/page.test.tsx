import React from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
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

  it("logs in with the shared demo credentials and redirects to /programs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "tok", email: "cm@workwell.dev", role: "ROLE_CASE_MANAGER" })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SandboxPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    expect(mockLogin).toHaveBeenCalledWith("tok", "cm@workwell.dev", "ROLE_CASE_MANAGER");
    expect(mockReplace).toHaveBeenCalledWith("/programs");
  });
});
