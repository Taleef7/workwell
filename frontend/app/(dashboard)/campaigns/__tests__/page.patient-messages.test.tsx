/**
 * Q1: on a patient deployment a campaign sends one message per patient and never sends for the depression or
 * substance use measures. The page says how many messages go out (not how many gaps), how many gaps were
 * left out and why, and the send confirmation counts messages.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api/hooks", () => ({ useApi: () => ({ get, post }) }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER", email: "cm@example.com" } }) }));

import CampaignsPage from "../page";

const recipient = (caseId: string, employeeId: string) => ({
  campaignId: "", caseId, employeeId, employeeName: employeeId, channel: "EMAIL", toAddress: `${employeeId}@x`,
  status: "PREVIEW", messageId: null, sentAt: "",
});

beforeEach(() => {
  get.mockReset().mockResolvedValue([]);
  post.mockReset();
});

describe("campaigns: one message per patient, sensitive measures withheld (Q1)", () => {
  it("reports messages and withheld gaps, and the confirmation counts messages", async () => {
    post.mockResolvedValue({
      campaignId: null, channel: "EMAIL", dryRun: true, total: 3, sent: 0, failed: 0, simulated: 0,
      messages: 2, withheld: 2,
      recipients: [recipient("c1", "pat-1"), recipient("c2", "pat-1"), recipient("c3", "pat-2")],
    });
    render(<CampaignsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Dry run" }));
    expect(await screen.findByText(/2 messages, one per (patient|employee), covering 3 gaps\./)).toBeInTheDocument();
    expect(screen.getByText(/2 open gaps left out: campaigns never send for the depression or substance use measures\./)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Send campaign" }));
    await waitFor(() => expect(screen.getByText(/This sends 2 messages via EMAIL/)).toBeInTheDocument());
  });

  it("says nothing extra when each gap is its own message and nothing is withheld", async () => {
    post.mockResolvedValue({
      campaignId: null, channel: "EMAIL", dryRun: true, total: 2, sent: 0, failed: 0, simulated: 0,
      messages: 2, withheld: 0, recipients: [recipient("c1", "e-1"), recipient("c2", "e-2")],
    });
    render(<CampaignsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Dry run" }));
    await screen.findByText(/Dry run preview/);
    expect(screen.queryByText(/one per (patient|employee)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/left out/)).not.toBeInTheDocument();
  });
});
