import { afterEach, describe, expect, it, vi } from "vitest";

async function loadWith(val: string | undefined) {
  vi.resetModules();
  if (val === undefined) {
    vi.stubEnv("NEXT_PUBLIC_PUBLIC_DEMO", "");
    delete process.env.NEXT_PUBLIC_PUBLIC_DEMO;
  } else {
    vi.stubEnv("NEXT_PUBLIC_PUBLIC_DEMO", val);
  }
  return await import("@/lib/public-demo");
}

afterEach(() => vi.unstubAllEnvs());

describe("public-demo", () => {
  it("defaults to true (on) when unset", async () => {
    const m = await loadWith(undefined);
    expect(m.PUBLIC_DEMO).toBe(true);
  });
  it("is true when set to 'on'", async () => {
    const m = await loadWith("on");
    expect(m.PUBLIC_DEMO).toBe(true);
  });
  it("is false when set to 'off'", async () => {
    const m = await loadWith("off");
    expect(m.PUBLIC_DEMO).toBe(false);
  });

  describe("isPilotMode and canSeeEngineering", () => {
    it("isPilotMode is false when PUBLIC_DEMO is true, and canSeeEngineering allows non-admin", async () => {
      const m = await loadWith("on");
      expect(m.isPilotMode()).toBe(false);
      expect(m.canSeeEngineering("ROLE_CASE_MANAGER")).toBe(true);
      expect(m.canSeeEngineering("ROLE_VIEWER")).toBe(true);
      expect(m.canSeeEngineering(undefined)).toBe(true);
      expect(m.canSeeEngineering("ROLE_ADMIN")).toBe(true);
    });

    it("isPilotMode is true when PUBLIC_DEMO is false, and canSeeEngineering allows only ADMIN", async () => {
      const m = await loadWith("off");
      expect(m.isPilotMode()).toBe(true);
      expect(m.canSeeEngineering("ROLE_ADMIN")).toBe(true);
      expect(m.canSeeEngineering("admin")).toBe(true);
      expect(m.canSeeEngineering("ROLE_CASE_MANAGER")).toBe(false);
      expect(m.canSeeEngineering("ROLE_VIEWER")).toBe(false);
      expect(m.canSeeEngineering(undefined)).toBe(false);
    });
  });
});

