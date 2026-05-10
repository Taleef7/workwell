"use client";

import { useState } from "react";
import { emitToast } from "@/lib/toast";
import { measureStatusClass } from "@/lib/status";
import type { ApiClient } from "@/lib/api/client";
import type { MeasureDetail, ActivationReadiness, VersionHistoryItem } from "../types";
import { ImpactPreviewPanel } from "./ImpactPreviewPanel";
import { DataReadinessPanel } from "./DataReadinessPanel";

type Props = {
  measure: MeasureDetail;
  measureId: string;
  api: ApiClient;
  activationReadiness: ActivationReadiness | null;
  versionHistory: VersionHistoryItem[];
  canApprove: boolean;
  canActivate: boolean;
  canAdminDeprecate: boolean;
  onChanged: () => void;
  onError: (msg: string) => void;
};

export function ReleaseApprovalTab({
  measure,
  measureId,
  api,
  activationReadiness,
  versionHistory,
  canApprove,
  canActivate,
  canAdminDeprecate,
  onChanged,
  onError
}: Props) {
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);
  const [showActivateConfirm, setShowActivateConfirm] = useState(false);
  const [showDeprecateConfirm, setShowDeprecateConfirm] = useState(false);
  const [deprecateReason, setDeprecateReason] = useState("");

  const compileReady = !!activationReadiness && ["COMPILED", "WARNINGS"].includes((activationReadiness.compileStatus ?? "").toUpperCase());
  const testsReady = !!activationReadiness && activationReadiness.testValidationPassed;
  const hasValueSets = (measure.valueSets?.length ?? 0) > 0;
  const unresolvedValueSets = (measure.valueSets ?? []).filter((vs) => vs.resolvabilityStatus.toUpperCase() === "UNRESOLVED").length;
  const requiredSpecComplete =
    !!measure.policyRef?.trim() && !!measure.description?.trim() &&
    !!measure.eligibilityCriteria?.roleFilter?.trim() && !!measure.eligibilityCriteria?.siteFilter?.trim() &&
    !!measure.eligibilityCriteria?.programEnrollmentText?.trim() && !!measure.complianceWindow?.trim() &&
    (measure.requiredDataElements ?? []).filter(Boolean).length > 0;
  const approveEnabled = compileReady && testsReady;
  const approveDisabledReason = !compileReady ? "Compile status must be COMPILED or WARNINGS." : !testsReady ? "Test fixtures must pass validation." : "";

  async function approve() {
    onError("");
    try {
      await api.post(`/api/measures/${measureId}/approve`);
      setShowApproveConfirm(false);
      emitToast("Measure approved for release");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Approve failed");
    }
  }

  async function activate() {
    onError("");
    try {
      await api.post(`/api/measures/${measureId}/status`, { targetStatus: "Active" });
      setShowActivateConfirm(false);
      emitToast("Measure activated");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Activation failed");
    }
  }

  async function deprecate() {
    onError("");
    if (!deprecateReason.trim()) { onError("Deprecation reason is required."); return; }
    try {
      await api.post(`/api/measures/${measureId}/deprecate`, { reason: deprecateReason.trim() });
      setShowDeprecateConfirm(false);
      setDeprecateReason("");
      emitToast("Measure deprecated");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Deprecation failed");
    }
  }

  return (
    <>
      <div className="grid gap-3 rounded-md border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-900">Readiness Checklist</h3>
        <div className="grid gap-2 text-sm">
          <p>Compile Status: <span className={compileReady ? "text-emerald-700" : "text-red-700"}>{compileReady ? "✅" : "❌"} {activationReadiness?.compileStatus ?? "UNKNOWN"}</span></p>
          <p>Test Fixtures: <span className={testsReady ? "text-emerald-700" : "text-red-700"}>{testsReady ? "✅" : "❌"} {activationReadiness?.testFixtureCount ?? 0} fixtures</span></p>
          <p>
            Value Set Resolvability:{" "}
            {hasValueSets ? (
              unresolvedValueSets === 0 ? <span className="text-emerald-700">✅ All resolved</span> : <span className="text-red-700">❌ {unresolvedValueSets} unresolved</span>
            ) : (
              <span className="text-amber-700">⚠️ No value sets attached</span>
            )}
          </p>
          <p>Required Spec Fields: <span className={requiredSpecComplete ? "text-emerald-700" : "text-red-700"}>{requiredSpecComplete ? "✅ Complete" : "❌ Incomplete"}</span></p>
        </div>

        <DataReadinessPanel measureId={measureId} api={api} />

        <h3 className="mt-2 text-sm font-semibold text-slate-900">Version History</h3>
        {versionHistory.length === 0 ? (
          <p className="text-sm text-slate-600">No versions found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-1">Version</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1">Author</th>
                  <th className="px-2 py-1">Created</th>
                  <th className="px-2 py-1">Change Summary</th>
                </tr>
              </thead>
              <tbody>
                {versionHistory.map((entry) => (
                  <tr key={entry.id} className="border-t border-slate-200">
                    <td className="px-2 py-1">{entry.version}</td>
                    <td className="px-2 py-1"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${measureStatusClass(entry.status)}`}>{entry.status}</span></td>
                    <td className="px-2 py-1">{entry.author}</td>
                    <td className="px-2 py-1">{new Date(entry.createdAt).toLocaleDateString()}</td>
                    <td className="px-2 py-1">{entry.changeSummary || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {measure.status === "Draft" && canApprove ? (
          <div className="mt-2">
            <button
              className="rounded-md bg-blue-700 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!approveEnabled}
              title={!approveEnabled ? approveDisabledReason : "Approve for release"}
              onClick={() => setShowApproveConfirm(true)}
            >
              Approve for Release
            </button>
          </div>
        ) : null}

        {measure.status === "Approved" && canApprove ? (
          <div className="mt-2 space-y-3">
            <ImpactPreviewPanel measureId={measureId} api={api} />
            <button
              className="rounded-md bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canActivate}
              title={!canActivate ? "Resolve blockers before activating." : "Activate measure"}
              onClick={() => setShowActivateConfirm(true)}
            >
              Activate Measure
            </button>
          </div>
        ) : null}

        {measure.status === "Active" && canAdminDeprecate ? (
          <div className="mt-2">
            <button className="rounded-md bg-slate-700 px-3 py-2 text-xs font-semibold text-white" onClick={() => setShowDeprecateConfirm(true)}>
              Deprecate
            </button>
          </div>
        ) : null}
      </div>

      {showApproveConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50">
          <div className="w-full max-w-lg rounded-lg bg-white p-4">
            <h3 className="text-base font-semibold text-slate-900">Approve for Release</h3>
            <p className="mt-2 text-sm text-slate-700">Confirm approval with checklist summary below:</p>
            <ul className="mt-2 list-disc pl-5 text-sm text-slate-700">
              <li>Compile: {activationReadiness?.compileStatus ?? "UNKNOWN"}</li>
              <li>Fixtures Valid: {testsReady ? "Yes" : "No"}</li>
              <li>Value Sets Attached: {hasValueSets ? "Yes" : "No"}</li>
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold" onClick={() => setShowApproveConfirm(false)}>Cancel</button>
              <button className="rounded bg-blue-700 px-3 py-2 text-xs font-semibold text-white" onClick={approve}>Confirm</button>
            </div>
          </div>
        </div>
      ) : null}

      {showActivateConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50">
          <div className="w-full max-w-lg rounded-lg bg-white p-4">
            <h3 className="text-base font-semibold text-slate-900">Activate Measure</h3>
            <p className="mt-2 text-sm text-slate-700">Activating this version replaces any currently Active version.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold" onClick={() => setShowActivateConfirm(false)}>Cancel</button>
              <button className="rounded bg-emerald-700 px-3 py-2 text-xs font-semibold text-white" onClick={activate}>Confirm Activate</button>
            </div>
          </div>
        </div>
      ) : null}

      {showDeprecateConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50">
          <div className="w-full max-w-lg rounded-lg bg-white p-4">
            <h3 className="text-base font-semibold text-slate-900">Deprecate Measure</h3>
            <p className="mt-2 text-sm text-slate-700">Deprecation reason is required.</p>
            <textarea
              className="mt-2 min-h-24 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              placeholder="Enter deprecation reason..."
              value={deprecateReason}
              onChange={(e) => setDeprecateReason(e.target.value)}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold" onClick={() => setShowDeprecateConfirm(false)}>Cancel</button>
              <button className="rounded bg-slate-700 px-3 py-2 text-xs font-semibold text-white" onClick={deprecate}>Confirm Deprecate</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
