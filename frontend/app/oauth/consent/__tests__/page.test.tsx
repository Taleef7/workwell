import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = { get: vi.fn(), post: vi.fn() };
const leaveTo = vi.fn();
vi.mock("@/lib/api/hooks", () => ({ useApi: () => api }));
vi.mock("@/lib/navigate", () => ({ leaveTo: (url: string) => leaveTo(url) }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ token: "t", user: { email: "cm@workwell.dev", role: "ROLE_CASE_MANAGER" } }) }));

import ConsentPage, { type ConsentDetails } from "../page";

const DETAILS: ConsentDetails = {
  clientName: "mcp-remote",
  verified: false,
  clientHost: null,
  redirectOrigin: "http://localhost:4123",
  loopback: true,
  scope: "mcp",
  resource: "https://api.workwell.test/mcp",
  user: { email: "cm@workwell.dev", role: "ROLE_CASE_MANAGER" },
  canApprove: true,
  declineRedirect: "http://localhost:4123/oauth/callback?error=access_denied&state=s",
};

describe("MCP consent page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, "", "/oauth/consent?request=signed.request.blob");
  });

  it("shows what the server verified, then sends the approval to the client's redirect", async () => {
    api.get.mockResolvedValue(DETAILS);
    api.post.mockResolvedValue({ redirect: "http://localhost:4123/oauth/callback?code=c&state=s&iss=https%3A%2F%2Fapi.workwell.test" });
    render(<ConsentPage />);
    expect(await screen.findByRole("heading", { name: "Connect mcp-remote to WorkWell?" })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/api/oauth/consent?request=signed.request.blob", { cache: "no-store" });
    expect(screen.getByTestId("consent-identity")).toHaveTextContent(/self-registered client/i);
    expect(screen.getByTestId("consent-redirect")).toHaveTextContent("http://localhost:4123");
    expect(screen.getByTestId("consent-loopback-warning")).toHaveTextContent(/started this connection yourself, just now, on this computer/);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(api.post).toHaveBeenCalledWith("/api/oauth/consent", { request: "signed.request.blob", decision: "approve" });
    await waitFor(() => expect(leaveTo).toHaveBeenCalledWith("http://localhost:4123/oauth/callback?code=c&state=s&iss=https%3A%2F%2Fapi.workwell.test"));
  });

  it("names a verified client by the host its metadata came from", async () => {
    api.get.mockResolvedValue({ ...DETAILS, clientName: "Claude", verified: true, clientHost: "claude.ai", redirectOrigin: "https://claude.ai", loopback: false });
    render(<ConsentPage />);
    expect(await screen.findByTestId("consent-identity")).toHaveTextContent(/published by claude\.ai/);
    expect(screen.queryByTestId("consent-loopback-warning")).not.toBeInTheDocument();
  });

  // A metadata document proves who published a client, not who listens on a localhost port: anyone can send
  // Claude Code's client id with their own port, so a loopback redirect is never shown as verified.
  it("never calls a client verified when its code goes to a loopback address", async () => {
    api.get.mockResolvedValue({ ...DETAILS, clientName: "Claude Code", verified: true, clientHost: "claude.ai", loopback: true });
    render(<ConsentPage />);
    const identity = await screen.findByTestId("consent-identity");
    expect(identity).not.toHaveTextContent(/verified/i);
    expect(identity).toHaveTextContent(/program on your computer/);
    expect(screen.getByTestId("consent-loopback-warning")).toBeInTheDocument();
  });

  // A viewer may never POST (the sandbox rule), so Decline must work without one: it follows the decline
  // redirect the server put in the details.
  it("offers only Decline to someone who cannot approve, and declines without a write", async () => {
    api.get.mockResolvedValue({ ...DETAILS, canApprove: false, user: { email: "viewer@workwell.dev", role: "ROLE_VIEWER" } });
    render(<ConsentPage />);
    expect(await screen.findByText(/only a case manager or admin/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(leaveTo).toHaveBeenCalledWith("http://localhost:4123/oauth/callback?error=access_denied&state=s");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("says so when the request is expired or forged, and offers nothing to approve", async () => {
    api.get.mockRejectedValue(new Error("This sign-in request has expired or is not valid. Start again from your MCP client."));
    render(<ConsentPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired or is not valid/);
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
});
