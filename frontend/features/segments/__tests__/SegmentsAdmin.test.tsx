import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/features/segments/hooks/useSegments", () => ({
  useSegments: () => ({
    segments: [
      {
        id: "s1",
        name: "OSHA Safety-Sensitive",
        description: "",
        enabled: true,
        rule: { match: "ANY", conditions: [] },
        measureIds: ["audiogram"],
        overrides: [],
        createdBy: "",
        createdAt: "",
        updatedAt: "",
      },
    ],
    loading: false,
    error: null,
    refetch: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
}));
// Stable client object (the real useApi() is memoized). A fresh object per render would make the
// api-dependent effects re-run forever and crash the worker.
const apiMock = {
  get: vi.fn().mockResolvedValue([{ id: "audiogram", name: "Audiogram", status: "Active" }]),
  post: vi.fn().mockResolvedValue({ count: 5, members: [] }),
};
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const authHolder = { role: "ROLE_ADMIN" as string };
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: authHolder.role } }) }));

import { SegmentsAdmin } from "@/features/segments/SegmentsAdmin";

describe("SegmentsAdmin", () => {
  it("renders the group list and opens the editor on New group", async () => {
    authHolder.role = "ROLE_ADMIN";
    render(<SegmentsAdmin />);
    expect(await screen.findByText("OSHA Safety-Sensitive")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new group/i }));
    expect(await screen.findByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("hides New group for non-admin roles", async () => {
    authHolder.role = "ROLE_CASE_MANAGER";
    render(<SegmentsAdmin />);
    expect(await screen.findByText("OSHA Safety-Sensitive")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new group/i })).toBeNull();
  });
});
