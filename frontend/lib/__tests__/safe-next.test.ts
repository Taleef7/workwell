import { describe, it, expect } from "vitest";
import { loginHref, safeNext } from "../safe-next";

const ORIGIN = "https://twh.os.mieweb.org";

describe("safeNext", () => {
  it("keeps a path on this origin, with its query", () => {
    expect(safeNext("/oauth/consent?request=abc", ORIGIN)).toBe("/oauth/consent?request=abc");
  });

  it("refuses anything that resolves to another origin, however it is spelled", () => {
    for (const next of ["//evil.example/x", "/\\evil.example", "/\t/evil.example", "https://evil.example/", "javascript:alert(1)", "evil.example", "", null, undefined]) {
      expect(safeNext(next as string | null | undefined, ORIGIN)).toBeNull();
    }
  });
});

describe("loginHref", () => {
  it("remembers an OAuth page, and nothing else", () => {
    expect(loginHref("/oauth/consent", "?request=a%2Bb")).toBe(`/login?next=${encodeURIComponent("/oauth/consent?request=a%2Bb")}`);
    expect(loginHref("/worklist", "?x=1")).toBe("/login");
    expect(loginHref(null, "")).toBe("/login");
  });
});
