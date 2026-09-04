import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { setSubject, subject } from "@/test/mocks/terminology";

vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ token: null, logout: vi.fn(), updateToken: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { GlobalSearch } from "./GlobalSearch";

beforeEach(() => {
  setSubject("employee");
  server.use(
    http.get("*/api/employees/search", () =>
      HttpResponse.json([
        { externalId: "emp-041", name: "Ada Lovelace", role: "Nurse", site: "HQ", latestOutcome: "OVERDUE" },
      ])
    )
  );
});

describe("GlobalSearch terminology", () => {
  it.each([
    ["employee", "Search employees", "Nurse · HQ"],
    ["patient", "Search patients", "HQ"],
  ] as const)("shows %s result context without an occupational role", async (term, label, context) => {
    setSubject(term);
    render(<GlobalSearch />);
    await userEvent.type(screen.getByRole("textbox", { name: label }), "Ada");

    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeInTheDocument(), { timeout: 1000 });
    expect(screen.getByRole("button", { name: /Ada Lovelace/ })).toHaveTextContent(context);
    if (term === "patient") {
      expect(screen.queryByText("Nurse · HQ", { exact: true })).not.toBeInTheDocument();
    }
  });
});
