import { http, HttpResponse } from "msw";

export const handlers = [
  http.get("*/api/cases", ({ request }) => {
    const url = new URL(request.url);
    const slaBreached = url.searchParams.get("slaBreached") === "true";
    return HttpResponse.json({
      content: [
        {
          caseId: "case-001",
          employeeId: "EMP-001",
          employeeName: "Jane Smith",
          site: "Site A",
          measureVersionId: "mv-001",
          measureName: "Annual Audiogram",
          measureVersion: "1.0",
          evaluationPeriod: "2026-05-01",
          status: "OPEN",
          priority: "HIGH",
          assignee: "cm@workwell.dev",
          currentOutcomeStatus: "OVERDUE",
          lastRunId: "run-001",
          exclusionReason: null,
          waiverExpiresAt: null,
          waiverExpired: false,
          updatedAt: new Date().toISOString(),
          slaRemainingDays: slaBreached ? -3 : 5,
          slaBreached: slaBreached,
        },
      ],
      totalElements: 1,
      totalPages: 1,
    });
  }),

  http.get("*/api/cases/:id", ({ params }) => {
    return HttpResponse.json({
      caseId: params.id,
      employeeId: "EMP-001",
      employeeName: "Jane Smith",
      site: "Site A",
      measureName: "Annual Audiogram",
      measureVersion: "1.0",
      currentOutcomeStatus: "OVERDUE",
      priority: "HIGH",
      status: "OPEN",
      evaluationPeriod: "2026-05-01",
      actions: [],
      timeline: [],
    });
  }),

  http.post("*/api/cases/:id/actions/outreach", () => {
    return HttpResponse.json({ success: true });
  }),

  http.post("*/api/measures/:id/cql/compile", () => {
    return HttpResponse.json({
      status: "ERROR",
      errors: [
        "Line 5, Column 12: Undefined identifier 'In Hearing Program'",
      ],
      warnings: [],
    });
  }),

  http.get("*/api/measures", () => {
    return HttpResponse.json({
      content: [
        {
          id: "m-001",
          name: "Annual Audiogram",
          status: "ACTIVE",
          version: "1.0",
          owner: "admin",
          tags: [],
          updatedAt: new Date().toISOString(),
        },
      ],
    });
  }),
];
