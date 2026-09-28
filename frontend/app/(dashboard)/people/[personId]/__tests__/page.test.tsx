import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const get = vi.fn();
const apiMock = { get, post: vi.fn() };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER" } }) }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ personId: "person-40c16184" }),
  useRouter: () => ({ push: vi.fn() }),
}));

import PersonDetailPage from "../page";

const entry = (evaluatedAt: string, runKind: string, overrides: Record<string, unknown> = {}) => ({
  measureId: "cms125",
  measureName: "Breast Cancer Screening",
  status: "MISSING_DATA",
  displayStatus: "OUT_OF_POPULATION",
  evaluatedAt,
  runId: `run-${runKind}`,
  runKind,
  tenantId: "maui",
  tenantName: "Maui Pilot Clinic",
  externalId: "pat-04403",
  sourceStatus: "ACTIVE",
  ...overrides,
});

// #655: pat-04403 (a 30-year-old) showed "MISSING DATA" for breast screening where the patient page says
// "Not in population", and a nightly plus a same-day rerun showed as two identical rows.
describe("Person history (#655)", () => {
  it("reads status as the patient page does, and names each row's run", async () => {
    setSubject("patient");
    get.mockResolvedValue({
      person: {
        personId: "person-40c16184",
        displayName: "Adriana Aoki",
        nationalId: null,
        dateOfBirth: "1996-09-24",
        crossSystem: false,
        sources: [{ tenantId: "maui", tenantName: "Maui Pilot Clinic", externalId: "pat-04403", name: "Adriana Aoki", role: "", site: "Kahului", status: "ACTIVE" }],
      },
      timeline: {
        entries: [
          entry("2026-09-24T15:30:00.000Z", "SUBJECT"),
          entry("2026-09-24T12:05:00.000Z", "SCHEDULED"),
          entry("2026-09-23T12:05:00.000Z", "MANUAL", { measureId: "cms2", measureName: "Depression screening", status: "COMPLIANT", displayStatus: "COMPLIANT" }),
        ],
        move: null,
      },
    });
    render(<PersonDetailPage />);
    const table = (await screen.findAllByText("Breast Cancer Screening", { selector: "td" }))[0]!.closest("table")!;
    const rows = within(table).getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("Not in population");
    expect(rows[0]).toContain("Single-patient run");
    expect(rows[1]).toContain("Not in population");
    expect(rows[1]).toContain("Nightly");
    expect(rows[2]).toContain("Manual run");
    // Codex on #722: two runs of one kind in one minute are told apart by the run's short id.
    expect(rows[0]).toContain("run-SUBJ");
    expect(rows[1]).toContain("run-SCHE");
    expect(within(table).queryByText(/missing data/i)).not.toBeInTheDocument();
    // Two runs on one day are told apart by their time, not only the date.
    const at = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
    expect(rows[0]).toContain(at("2026-09-24T15:30:00.000Z"));
    expect(rows[1]).toContain(at("2026-09-24T12:05:00.000Z"));
    expect(screen.getByRole("link", { name: "Open patient page" })).toHaveAttribute("href", "/patients/pat-04403");
  });

  it("names each row's measure by the label the cards use (#648)", async () => {
    setSubject("patient");
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([{ id: "cms125", name: "Breast Cancer Screening", identity: { cmsId: "CMS125", mipsQualityId: "112" } }]);
      }
      return Promise.resolve({
        person: {
          personId: "person-40c16184",
          displayName: "Adriana Aoki",
          nationalId: null,
          dateOfBirth: "1996-09-24",
          crossSystem: false,
          sources: [{ tenantId: "maui", tenantName: "Maui Pilot Clinic", externalId: "pat-04403", name: "Adriana Aoki", role: "", site: "Kahului", status: "ACTIVE" }],
        },
        timeline: { entries: [entry("2026-09-24T12:05:00.000Z", "SCHEDULED")], move: null },
      });
    });
    render(<PersonDetailPage />);
    expect(await screen.findByText("MIPS 112 · CMS125 · Breast Cancer Screening", { selector: "td" })).toBeInTheDocument();
  });
});
