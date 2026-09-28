import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const getWithHeaders = vi.fn();
const apiMock = { get: vi.fn(), getWithHeaders };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER" } }) }));

import PeoplePage from "../page";

const person = (personId: string, externalId: string, dateOfBirth: string, site: string) => ({
  personId,
  displayName: "Adriana Aoki",
  nationalId: null,
  dateOfBirth,
  crossSystem: false,
  sources: [{ tenantId: "maui", tenantName: "Maui Pilot Clinic", externalId, name: "Adriana Aoki", role: "", site, status: "ACTIVE" }],
});

// #655: same-named patients were indistinguishable, a bare name per row. Seen live: pat-04403 (born
// 1996-09-24, Kahului) and pat-04566 (born 1999-06-12, Wailuku) both read "Adriana Aoki".
describe("People list (#655)", () => {
  it("tells same-named people apart by id, date of birth and clinic", async () => {
    getWithHeaders.mockResolvedValue({
      data: [person("person-1", "pat-04403", "1996-09-24", "Kahului"), person("person-2", "pat-04566", "1999-06-12", "Wailuku")],
      headers: new Headers({ "X-Total-Count": "2" }),
    });
    render(<PeoplePage />);
    const lines = await screen.findAllByTestId("people-row-identity");
    expect(lines.map((l) => l.textContent)).toEqual([
      "pat-04403 · born 1996-09-24 · Kahului",
      "pat-04566 · born 1999-06-12 · Wailuku",
    ]);
  });
});
