import { render, screen, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { server } from "../../test/msw/server";
import { GlobalSearch } from "../GlobalSearch";
import { SUBJECT } from "@/lib/terminology";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    token: "mock-jwt-token",
    user: { email: "quality-lead@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
    logout: vi.fn(),
    updateToken: vi.fn(),
  }),
}));

const searchResults = [
  {
    externalId: "pat-048",
    name: "Nilo Gray",
    role: "Patient",
    site: "Kihei Clinic",
    latestOutcome: null,
  },
];

const multipleResults = [
  {
    externalId: "pat-001",
    name: "Ari Wren",
    role: "Patient",
    site: "Wailuku Clinic",
    latestOutcome: "COMPLIANT",
  },
  {
    externalId: "pat-002",
    name: "Nia Calder",
    role: "Patient",
    site: "Kihei Clinic",
    latestOutcome: "OVERDUE",
  },
];

beforeEach(() => {
  mockPush.mockClear();
  server.use(
    http.get("*/api/employees/search", ({ request }) => {
      const url = new URL(request.url);
      const q = url.searchParams.get("q") ?? "";
      if (q.toLowerCase() === "nilo") {
        return HttpResponse.json(searchResults);
      }
      if (q.toLowerCase() === "multi") {
        return HttpResponse.json(multipleResults);
      }
      if (q.toLowerCase() === "error") {
        return HttpResponse.json({ error: "server_error" }, { status: 500 });
      }
      return HttpResponse.json([]);
    }),
  );
});

describe("GlobalSearch", () => {
  it("renders search input with terminology-aware placeholder and label", () => {
    render(<GlobalSearch />);
    const input = screen.getByRole("textbox", { name: new RegExp(`Search ${SUBJECT.plural}`, "i") });
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("placeholder", `Search ${SUBJECT.plural}…`);
  });

  it("shows search results when query matches", async () => {
    render(<GlobalSearch />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Nilo" } });

    expect(await screen.findByText("Nilo Gray")).toBeInTheDocument();
    expect(screen.getByText("Patient · Kihei Clinic")).toBeInTheDocument();
  });

  it("shows 'No employees found' row when query is >= 2 chars, loading is done, and results are empty", async () => {
    render(<GlobalSearch />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "unknown" } });

    const matches = await screen.findAllByText(`No ${SUBJECT.plural} found`);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces a non-2xx response the same way as empty results rather than swallowing into silence", async () => {
    render(<GlobalSearch />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "error" } });

    const matches = await screen.findAllByText(`No ${SUBJECT.plural} found`);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("navigates on Enter when exactly one result is shown", async () => {
    render(<GlobalSearch />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Nilo" } });

    expect(await screen.findByText("Nilo Gray")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockPush).toHaveBeenCalledWith("/employees/pat-048");
  });

  it("does not navigate on Enter while a new query is in flight (loading is true)", async () => {
    render(<GlobalSearch />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Nilo" } });

    expect(await screen.findByText("Nilo Gray")).toBeInTheDocument();
    mockPush.mockClear();

    // Type another letter, which triggers setQuery and sets loading = true via debounce effect
    fireEvent.change(input, { target: { value: "NiloX" } });
    // Press Enter while new query is in flight
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockPush).not.toHaveBeenCalled();
  });

  it("resets loading to false when query length falls below 2 so subsequent searches are not stuck", async () => {
    render(<GlobalSearch />);
    const input = screen.getByRole("textbox");

    // Start an in-flight query
    fireEvent.change(input, { target: { value: "unknown" } });
    // Immediately abort by backspacing to 1 char before search settles
    fireEvent.change(input, { target: { value: "u" } });

    // Now search for empty result again
    fireEvent.change(input, { target: { value: "unknown" } });
    const matches = await screen.findAllByText(`No ${SUBJECT.plural} found`);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("does not navigate on Enter when multiple results are shown", async () => {
    render(<GlobalSearch />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "multi" } });

    expect(await screen.findByText("Ari Wren")).toBeInTheDocument();
    expect(screen.getByText("Nia Calder")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("does not search or open dropdown when query length is less than 2 chars", async () => {
    render(<GlobalSearch />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "N" } });

    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(screen.queryByText("Nilo Gray")).not.toBeInTheDocument();
    expect(screen.queryByText(`No ${SUBJECT.plural} found`)).not.toBeInTheDocument();
  });
});
