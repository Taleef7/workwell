import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StudioPage from "../page";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

let currentRole = "ROLE_CASE_MANAGER";
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: currentRole } }),
}));

describe("StudioPage pilot mode route guard", () => {
  beforeEach(() => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";
  });

  it("renders access denied for non-admin in pilot mode", () => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";

    render(<StudioPage />);

    expect(screen.getByText("Studio")).toBeInTheDocument();
    expect(screen.getByText(/Your current role does not have access to this section/i)).toBeInTheDocument();
  });

  it("renders studio content for admin in pilot mode", () => {
    setPublicDemo(false);
    currentRole = "ROLE_ADMIN";

    render(<StudioPage />);

    expect(screen.queryByText(/Your current role does not have access to this section/i)).toBeNull();
    expect(screen.getByText("Browse measures")).toBeInTheDocument();
  });

  it("companion: renders studio content for non-admin when PUBLIC_DEMO is true", () => {
    setPublicDemo(true);
    currentRole = "ROLE_CASE_MANAGER";

    render(<StudioPage />);

    expect(screen.queryByText(/Your current role does not have access to this section/i)).toBeNull();
    expect(screen.getByText("Browse measures")).toBeInTheDocument();
  });
});

