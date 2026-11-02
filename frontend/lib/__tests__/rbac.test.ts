import { describe, expect, it } from "vitest";
import {
  ROLES,
  canActInBulk,
  canExportData,
  canExportReports,
  canManageCases,
  canManagePanels,
  canReconcileIdentity,
  canRunCampaigns,
  canRunMeasures,
  canUseLists,
  canViewOrders,
  canViewPeople,
  homeRouteFor,
} from "../rbac";

/**
 * The seat split (#880, LOCKED §4A.9), mirroring `backend-ts/src/auth/authorize.ts`. The server refuses
 * whatever the UI shows; these keep the UI from offering what the server will refuse.
 */
describe("the lead and staff seats", () => {
  const lead = ROLES.CASE_MANAGER;
  const staff = ROLES.QUALITY_STAFF;

  it("staff work single cases, export the CSVs and read orders", () => {
    for (const can of [canManageCases, canExportData, canViewOrders]) {
      expect(can(staff), can.name).toBe(true);
      expect(can(lead), can.name).toBe(true);
    }
  });

  it("the practice-wide levers stay with the lead and the admin", () => {
    for (const can of [canActInBulk, canUseLists, canManagePanels, canExportReports, canRunCampaigns, canRunMeasures, canViewPeople, canReconcileIdentity]) {
      expect(can(staff), can.name).toBe(false);
      expect(can(lead), can.name).toBe(true);
      expect(can(ROLES.ADMIN), can.name).toBe(true);
    }
  });

  it("the read-only viewer gets none of them", () => {
    for (const can of [canManageCases, canExportData, canActInBulk, canUseLists, canManagePanels, canExportReports]) {
      expect(can(ROLES.VIEWER), can.name).toBe(false);
    }
  });

  it("each seat lands on its own day: the lead the work list, staff their own cases", () => {
    expect(homeRouteFor(lead)).toBe("/worklist");
    expect(homeRouteFor(staff)).toBe("/cases?view=mine");
    expect(homeRouteFor(ROLES.ADMIN)).toBe("/programs");
    expect(homeRouteFor(ROLES.VIEWER)).toBe("/programs");
    expect(homeRouteFor("quality_staff"), "prefix and casing tolerant").toBe("/cases?view=mine");
  });
});
