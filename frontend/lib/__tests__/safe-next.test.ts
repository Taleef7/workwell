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

  // These stay on this origin when resolved, but their path is `//evil.example`, which the router follows
  // off-site as a protocol-relative URL.
  it("refuses a same-origin path that resolves to a protocol-relative one", () => {
    for (const next of ["/.//evil.example", "/..//evil.example", "/%2e//evil.example", "/oauth/..//evil.example"]) {
      expect(safeNext(next, ORIGIN)).toBeNull();
    }
  });

  it("returns only to the consent page", () => {
    expect(safeNext("/worklist", ORIGIN)).toBeNull();
    expect(safeNext("/oauth/consent/../../admin", ORIGIN)).toBeNull();
  });
});

describe("loginHref", () => {
  it("remembers the consent page, and nothing else", () => {
    expect(loginHref("/oauth/consent", "?request=a%2Bb")).toBe(`/login?next=${encodeURIComponent("/oauth/consent?request=a%2Bb")}`);
    expect(loginHref("/worklist", "?x=1")).toBe("/login");
    expect(loginHref("/oauth/other", "")).toBe("/login");
    expect(loginHref(null, "")).toBe("/login");
  });
});
