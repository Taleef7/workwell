import { http, HttpResponse } from "msw";

// Matches the actual backend contract: /api/cases returns CaseSummary[]
export const handlers = [
  // Default: refresh cookie absent/invalid → 401. Override per-test with server.use() for success paths.
  http.post("*/api/auth/refresh", () => HttpResponse.json({ error: "invalid refresh token" }, { status: 401 })),

  http.post("*/api/auth/logout", () => new HttpResponse(null, { status: 204 })),

  http.get("*/api/cases", () => {
    return HttpResponse.json([
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
        slaRemainingDays: 5,
        slaBreached: false,
      },
    ]);
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

  // /api/measures returns MeasureOption[] directly; status uses title-case "Active"
  http.get("*/api/measures", () => {
    return HttpResponse.json([
      {
        id: "m-001",
        name: "Annual Audiogram",
        status: "Active",
        version: "1.0",
        owner: "admin",
        tags: [],
        updatedAt: new Date().toISOString(),
      },
    ]);
  }),
];
