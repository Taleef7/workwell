/**
 * The provider a clinician's sign-in is linked to (#870): read once per signed-in email, by a VIEWER
 * only, and never cached as "not linked" when the read failed.
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
import { MyProviderProvider, parseMyProvider, useMyProvider } from "../use-my-provider";

vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const auth = vi.hoisted(() => ({
  token: "mock-token" as string | null,
  user: { email: "clinician@example.test", role: "ROLE_VIEWER" } as { email: string; role: string } | null,
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ token: auth.token, user: auth.user }),
}));

const get = vi.fn();
// A stable object, as the real hook returns: a fresh one per render would re-fire the `[api]` effect.
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const SILVA = { id: "maui-prov-011", name: "Dr. Ana Silva", location: "Wailuku" };
const STONE = { id: "maui-prov-012", name: "Dr. Aven Stone", location: "Kahului Clinic" };

const mineCalls = () => get.mock.calls.filter((c) => c[0] === "/api/providers/mine").length;

const wrapper = ({ children }: { children: React.ReactNode }) => <MyProviderProvider>{children}</MyProviderProvider>;
const renderMine = () => renderHook(() => useMyProvider(), { wrapper });

beforeEach(() => {
  setSubject("patient");
  auth.token = "mock-token";
  auth.user = { email: "clinician@example.test", role: "ROLE_VIEWER" };
  get.mockReset().mockResolvedValue({ provider: SILVA });
});

describe("parseMyProvider", () => {
  it("keeps exactly id, name and location from a well-formed answer", () => {
    expect(parseMyProvider({ provider: { ...SILVA, tenantId: "maui" } })).toEqual(SILVA);
  });

  it("reads a null provider as not linked", () => {
    expect(parseMyProvider({ provider: null })).toBeNull();
  });

  it.each([
    ["a missing name", { provider: { id: "maui-prov-011", location: "Wailuku" } }],
    ["an empty id", { provider: { ...SILVA, id: "" } }],
    ["a numeric location", { provider: { ...SILVA, location: 7 } }],
    ["no provider key", { id: "maui-prov-011" }],
    ["a provider that is a string", { provider: "maui-prov-011" }],
  ])("reads %s as not linked", (_, body) => {
    expect(parseMyProvider(body)).toBeNull();
  });

  it.each([
    ["an array", [SILVA]],
    ["a string", "maui-prov-011"],
    ["a number", 11],
    ["null", null],
    ["undefined", undefined],
  ])("reads %s as not linked", (_, body) => {
    expect(parseMyProvider(body)).toBeNull();
  });
});

describe("MyProviderProvider", () => {
  it("is never loaded outside the provider", () => {
    const { result } = renderHook(() => useMyProvider());
    expect(result.current).toMatchObject({ provider: null, loaded: false, error: false });
  });

  it("asks once for a VIEWER and shares the answer", async () => {
    const { result, rerender } = renderMine();
    expect(result.current).toMatchObject({ provider: null, loaded: false });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current).toMatchObject({ provider: SILVA, error: false });
    rerender();
    rerender();
    expect(mineCalls()).toBe(1);
  });

  it.each(["ROLE_CASE_MANAGER", "ROLE_ADMIN", "ROLE_AUTHOR"])("never asks for %s, and answers not linked at once", async (role) => {
    auth.user = { email: "staff@example.test", role };
    const { result } = renderMine();
    expect(result.current).toMatchObject({ provider: null, loaded: true, error: false });
    // Give a stray request every chance to fire before saying it did not.
    await act(async () => {});
    expect(get).not.toHaveBeenCalled();
  });

  it("never asks for a VIEWER on the occupational deployment, where no seat is linked", async () => {
    setSubject("employee");
    const { result } = renderMine();
    expect(result.current).toMatchObject({ provider: null, loaded: true, error: false });
    await act(async () => {});
    expect(get).not.toHaveBeenCalled();
  });

  it("asks nothing without a session", async () => {
    auth.token = null;
    auth.user = null;
    const { result } = renderMine();
    await act(async () => {});
    expect(result.current).toMatchObject({ provider: null, loaded: false });
    expect(get).not.toHaveBeenCalled();
  });

  it("reports a failed read as an error, never as not linked, and retry asks again", async () => {
    get.mockReset().mockRejectedValueOnce(new Error("502")).mockResolvedValueOnce({ provider: SILVA });
    const { result } = renderMine();
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current).toMatchObject({ provider: null, error: true });
    expect(mineCalls()).toBe(1);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.provider).toEqual(SILVA));
    expect(result.current.error).toBe(false);
    expect(mineCalls()).toBe(2);
  });

  it("asks again for another signed-in email instead of reusing the old answer", async () => {
    get.mockReset().mockResolvedValueOnce({ provider: SILVA }).mockResolvedValueOnce({ provider: STONE });
    const { result, rerender } = renderMine();
    await waitFor(() => expect(result.current.provider).toEqual(SILVA));

    auth.user = { email: "other-clinician@example.test", role: "ROLE_VIEWER" };
    rerender();
    // The old seat's provider is never shown under the new email, not even for one render.
    expect(result.current).toMatchObject({ provider: null, loaded: false });
    await waitFor(() => expect(result.current.provider).toEqual(STONE));
    expect(mineCalls()).toBe(2);
  });
});
