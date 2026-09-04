import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subject as helperSubject, setSubject as setHelperSubject } from "@/test/mocks/terminology";
const terminologyMock = vi.hoisted(() => ({ subject: {} as Record<string, string> }));
vi.mock("@/lib/terminology", () => ({ SUBJECT: terminologyMock.subject }));

function applySubject(term: "employee" | "patient") {
  setHelperSubject(term);
  Object.assign(terminologyMock.subject, helperSubject);
}
applySubject("employee");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("HomePage", () => {
  it("renders all public demo affordances when NEXT_PUBLIC_PUBLIC_DEMO is on (default)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PUBLIC_DEMO", "on");
    vi.resetModules();
    const { default: HomePage } = await import("../page");

    render(<HomePage />);

    expect(screen.getByText(/Public sandbox · No login required/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /open sandbox/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /watch product walkthrough video/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /watch the 5-min walkthrough/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /view source on github/i })).toBeTruthy();
    const signIn = screen.getByRole("link", { name: /sign in/i });
    expect(signIn).toBeTruthy();
    expect(signIn.className).not.toContain("bg-primary-600");
  });

  it("suppresses public demo affordances and promotes Sign in when NEXT_PUBLIC_PUBLIC_DEMO is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_PUBLIC_DEMO", "off");
    vi.resetModules();
    const { default: HomePage } = await import("../page");

    render(<HomePage />);

    expect(screen.getByText(/Pilot sandbox · Sign in required/i)).toBeTruthy();
    expect(screen.queryByText(/Public sandbox · No login required/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /open sandbox/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /watch product walkthrough video/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /watch the 5-min walkthrough/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /view source on github/i })).toBeNull();

    const signIn = screen.getByRole("link", { name: /sign in/i });
    expect(signIn).toBeTruthy();
    expect(signIn.className).toContain("bg-primary-600");
  });
});

describe("HomePage terminology fallbacks", () => {
  it("keeps the employee tagline and description when env copy is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_TAGLINE", "");
    vi.stubEnv("NEXT_PUBLIC_APP_DESCRIPTION", "");
    vi.stubEnv("NEXT_PUBLIC_PUBLIC_DEMO", "off");
    applySubject("employee");
    vi.resetModules();
    const { default: HomePage } = await import("../page");

    render(<HomePage />);

    expect(screen.getByText("A clean operating surface for occupational-health compliance.")).toBeTruthy();
    expect(
      screen.getByText((content, element) =>
        (element?.tagName === "P" && content.includes("Occupational safety and clinical wellness measures") && content.includes("one reviewable dashboard")) ?? false,
      ),
    ).toBeTruthy();
  });

  it("derives patient fallback copy from SUBJECT.domain instead of occupational wording", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_TAGLINE", "");
    vi.stubEnv("NEXT_PUBLIC_APP_DESCRIPTION", "");
    vi.stubEnv("NEXT_PUBLIC_PUBLIC_DEMO", "off");
    applySubject("patient");
    vi.resetModules();
    const { default: HomePage } = await import("../page");

    render(<HomePage />);

    expect(screen.getByText("A clean operating surface for primary-care compliance.")).toBeTruthy();
    expect(
      screen.getByText(
        "Primary care clinical quality measures, complete case management, and a full audit trail — one reviewable dashboard.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/occupational/i)).toBeNull();
  });
});