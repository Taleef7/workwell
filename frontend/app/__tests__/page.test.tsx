import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
