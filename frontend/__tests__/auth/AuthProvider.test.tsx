import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { AuthProvider, useAuth } from "@/components/auth-provider";

// Mock next/navigation so AuthProvider doesn't crash in tests
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/dashboard",
}));

function TestConsumer() {
  const { user, token } = useAuth();
  return (
    <div>
      <span data-testid="token">{token ?? "null"}</span>
      <span data-testid="user">{user?.email ?? "null"}</span>
    </div>
  );
}

describe("AuthProvider", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders children", () => {
    render(
      <AuthProvider>
        <p>child</p>
      </AuthProvider>
    );
    expect(screen.getByText("child")).toBeInTheDocument();
  });

  it("exposes null token when localStorage is empty", () => {
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );
    expect(screen.getByTestId("token")).toHaveTextContent("null");
    expect(screen.getByTestId("user")).toHaveTextContent("null");
  });

  it("exposes token and user from localStorage when a valid JWT is present", () => {
    // Build a minimal JWT with exp 10 years from now
    const payload = { exp: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600 };
    const encoded = btoa(JSON.stringify(payload)).replace(/=/g, "");
    const fakeJwt = `header.${encoded}.signature`;

    localStorage.setItem("ww_token", JSON.stringify(fakeJwt));
    localStorage.setItem("ww_user", JSON.stringify({ email: "cm@workwell.dev", role: "ROLE_CASE_MANAGER" }));

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    expect(screen.getByTestId("token")).toHaveTextContent(fakeJwt);
    expect(screen.getByTestId("user")).toHaveTextContent("cm@workwell.dev");
  });

  it("exposes null token when JWT is expired", () => {
    const payload = { exp: Math.floor(Date.now() / 1000) - 3600 }; // expired 1h ago
    const encoded = btoa(JSON.stringify(payload)).replace(/=/g, "");
    const expiredJwt = `header.${encoded}.signature`;

    localStorage.setItem("ww_token", JSON.stringify(expiredJwt));
    localStorage.setItem("ww_user", JSON.stringify({ email: "cm@workwell.dev", role: "ROLE_CASE_MANAGER" }));

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    expect(screen.getByTestId("token")).toHaveTextContent("null");
  });

  it("login stores token and user in localStorage", () => {
    function LoginTrigger() {
      const { login, user } = useAuth();
      return (
        <>
          <button onClick={() => login("tok", "test@x.dev", "ROLE_ADMIN")}>login</button>
          <span data-testid="result">{user?.email ?? "none"}</span>
        </>
      );
    }

    render(
      <AuthProvider>
        <LoginTrigger />
      </AuthProvider>
    );

    expect(screen.getByTestId("result")).toHaveTextContent("none");
    act(() => {
      screen.getByRole("button", { name: "login" }).click();
    });
    expect(JSON.parse(localStorage.getItem("ww_token") ?? "null")).toBe("tok");
    expect(JSON.parse(localStorage.getItem("ww_user") ?? "null")).toMatchObject({ email: "test@x.dev" });
  });
});
