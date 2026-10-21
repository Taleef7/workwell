import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => api }));

import { McpAccessAdmin, claudeCodeCommand, claudeDesktopConfig, type TokenRow } from "../McpAccessAdmin";

const ISSUED = {
  token: "aaa.bbb.ccc",
  tokenId: "11111111-1111-4111-8111-111111111111",
  label: "Claude Desktop",
  role: "ROLE_CASE_MANAGER" as const,
  subject: "admin@workwell.dev",
  expiresAt: "2026-11-19T12:00:00.000Z",
  mcpUrl: "https://twh-api-ts.os.mieweb.org/mcp",
};
const row = (over: Partial<TokenRow>): TokenRow => ({
  tokenId: ISSUED.tokenId,
  label: "Claude Desktop",
  role: "ROLE_CASE_MANAGER",
  subject: "admin@workwell.dev",
  expiresAt: "2026-11-19T12:00:00.000Z",
  issuedAt: "2026-10-20T12:00:00.000Z",
  status: "active",
  ...over,
});

describe("McpAccessAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("creates a token, shows it once with ready-to-paste config, and hides it on Done", async () => {
    api.get.mockResolvedValueOnce({ tokens: [] }).mockResolvedValue({ tokens: [row({})] });
    api.post.mockResolvedValue(ISSUED);
    render(<McpAccessAdmin />);
    await waitFor(() => expect(screen.getByText(/no mcp tokens yet/i)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/label/i), "Claude Desktop");
    await userEvent.click(screen.getByRole("button", { name: /create token/i }));
    expect(api.post).toHaveBeenCalledWith("/api/admin/mcp-tokens", { label: "Claude Desktop", role: "ROLE_CASE_MANAGER", days: 30 });

    const issued = await screen.findByTestId("mcp-issued");
    expect(within(issued).getByText(/will not be shown again/i)).toBeInTheDocument();
    expect(within(issued).getByLabelText("MCP token")).toHaveValue("aaa.bbb.ccc");
    await userEvent.click(within(issued).getByRole("button", { name: "Copy token" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("aaa.bbb.ccc");
    await userEvent.click(within(issued).getByRole("button", { name: "Copy Claude Code command" }));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(claudeCodeCommand(ISSUED));

    // The list never carries the token; only the one-time box does, until Done.
    const list = await screen.findByTestId("mcp-token-list");
    expect(list.textContent).not.toContain("aaa.bbb.ccc");
    await userEvent.click(within(issued).getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("mcp-issued")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("aaa.bbb.ccc");
  });

  it("lists active, revoked and expired tokens, and revokes an active one after confirming", async () => {
    api.get.mockResolvedValueOnce({
      tokens: [
        row({ tokenId: "a", label: "laptop", status: "active" }),
        row({ tokenId: "r", label: "old", status: "revoked" }),
        row({ tokenId: "e", label: "lapsed", status: "expired" }),
      ],
    }).mockResolvedValue({ tokens: [row({ tokenId: "a", label: "laptop", status: "revoked" })] });
    api.delete.mockResolvedValue(undefined);
    render(<McpAccessAdmin />);
    const list = await screen.findByTestId("mcp-token-list");
    expect(within(list).getByText("revoked")).toBeInTheDocument();
    expect(within(list).getByText("expired")).toBeInTheDocument();
    expect(within(list).getAllByRole("button", { name: /revoke/i })).toHaveLength(1);

    await userEvent.click(within(list).getByRole("button", { name: "Revoke laptop" }));
    await userEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/admin/mcp-tokens/a"));
  });

  it("shows the server's refusal when minting fails", async () => {
    api.get.mockResolvedValue({ tokens: [] });
    api.post.mockRejectedValue(new Error("MCP tokens are unavailable: WORKWELL_PUBLIC_API_URL is not set"));
    render(<McpAccessAdmin />);
    await userEvent.type(await screen.findByLabelText(/label/i), "x");
    await userEvent.click(screen.getByRole("button", { name: /create token/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/WORKWELL_PUBLIC_API_URL/);
    expect(screen.queryByTestId("mcp-issued")).not.toBeInTheDocument();
  });

  it("the Claude Desktop config uses /mcp over http-only and keeps the header in an env var", () => {
    const config = JSON.parse(claudeDesktopConfig(ISSUED)) as { workwell: { args: string[]; env: { AUTH_HEADER: string } } };
    expect(config.workwell.args).toEqual(["-y", "mcp-remote", ISSUED.mcpUrl, "--transport", "http-only", "--header", "Authorization:${AUTH_HEADER}"]);
    expect(config.workwell.env.AUTH_HEADER).toBe("Bearer aaa.bbb.ccc");
    expect(claudeCodeCommand(ISSUED)).toBe(`claude mcp add --transport http workwell ${ISSUED.mcpUrl} --header "Authorization: Bearer aaa.bbb.ccc"`);
  });
});
