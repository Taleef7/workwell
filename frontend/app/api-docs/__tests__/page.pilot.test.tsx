import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ApiDocsPage from "../page";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

let currentRole = "ROLE_CASE_MANAGER";
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: currentRole } }),
}));

vi.mock("@/components/api-docs/api-reference", () => ({
  ApiReference: () => <div>Mocked Api Reference</div>,
}));

const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
  Promise.resolve(new Response(JSON.stringify({ openapi: "3.1", info: { title: "Integration API" } })))
);

describe("ApiDocsPage pilot mode route guard", () => {
  beforeEach(() => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";
    fetchSpy.mockClear();
  });

  it("renders access denied for non-admin in pilot mode", () => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";

    render(<ApiDocsPage />);

    expect(screen.getByText("API Documentation")).toBeInTheDocument();
    expect(screen.getByText(/Your current role does not have access to this section/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders api docs content for admin in pilot mode", () => {
    setPublicDemo(false);
    currentRole = "ROLE_ADMIN";

    render(<ApiDocsPage />);

    expect(screen.queryByText(/Your current role does not have access to this section/i)).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Integration API/i);
  });

  it("companion: renders api docs content for non-admin when PUBLIC_DEMO is true", () => {
    setPublicDemo(true);
    currentRole = "ROLE_CASE_MANAGER";

    render(<ApiDocsPage />);

    expect(screen.queryByText(/Your current role does not have access to this section/i)).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Integration API/i);
  });
});

