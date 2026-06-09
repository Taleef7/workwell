"use client";

import { useState } from "react";
import { emitToast } from "@/lib/toast";
import { formatStatusLabel, measureStatusClass, normalizeEnumValue } from "@/lib/status";
import type { ApiClient } from "@/lib/api/client";
import type { MeasureDetail, ActivationReadiness, VersionHistoryItem } from "../types";
import { ImpactPreviewPanel } from "./ImpactPreviewPanel";
import { DataReadinessPanel } from "./DataReadinessPanel";
import { ValueSetGovernancePanel } from "./ValueSetGovernancePanel";
import { AuditPacketExportButton } from "@/components/audit-packet-export-button";

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
  const [exportingMat, setExportingMat] = useState(false);
  const [approving, setApproving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [deprecating, setDeprecating] = useState(false);

  const measureVersionId = versionHistory.find(v => v.version === measure.version)?.id ?? "";

  const compileReady = !!activationReadiness && ["COMPILED", "WARNINGS"].includes(normalizeEnumValue(activationReadiness.compileStatus ?? ""));
  const testsReady = !!activationReadiness && activationReadiness.testValidationPassed;
  const hasValueSets = (measure.valueSets?.length ?? 0) > 0;
  const unresolvedValueSets = (measure.valueSets ?? []).filter((vs) => normalizeEnumValue(vs.resolvabilityStatus) === "UNRESOLVED").length;
  const requiredSpecComplete =
    !!measure.policyRef?.trim() && !!measure.description?.trim() &&
    !!measure.eligibilityCriteria?.roleFilter?.trim() && !!measure.eligibilityCriteria?.siteFilter?.trim() &&
    !!measure.eligibilityCriteria?.programEnrollmentText?.trim() && !!measure.complianceWindow?.trim() &&
    (measure.requiredDataElements ?? []).filter(Boolean).length > 0;
  const approveEnabled = compileReady && testsReady;
  const approveDisabledReason = !compileReady ? "Compile status must be COMPILED or WARNINGS." : !testsReady ? "Test fixtures must pass validation." : "";

  async function approve() {
    onError("");
    setApproving(true);
    try {
      await api.post(`/api/measures/${measureId}/approve`);
      setShowApproveConfirm(false);
      emitToast("Measure approved for release");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setApproving(false);
    }
  }

  async function activate() {
    onError("");
    setActivating(true);
    try {
      await api.post(`/api/measures/${measureId}/status`, { targetStatus: "Active" });
      setShowActivateConfirm(false);
      emitToast("Measure activated");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Activation failed");
    } finally {
      setActivating(false);
    }
  }

  async function deprecate() {
    onError("");
    if (!deprecateReason.trim()) { onError("Deprecation reason is required."); return; }
    setDeprecating(true);
    try {
      await api.post(`/api/measures/${measureId}/deprecate`, { reason: deprecateReason.trim() });
      setShowDeprecateConfirm(false);
      setDeprecateReason("");
      emitToast("Measure deprecated");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Deprecation failed");
    } finally {
      setDeprecating(false);
    }
  }

  async function exportMatBundle() {
    if (!measureVersionId) {
      onError("No measure version selected for MAT export.");
      return;
    }
    setExportingMat(true);
    onError("");
    try {
      const blob = await api.downloadBlob(
        `/api/measures/${measureId}/versions/${measureVersionId}/export/mat?format=xml`
      );
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const safeName = (measure.name || "measure").replace(/[^A-Za-z0-9_-]+/g, "-");
      anchor.href = url;
      anchor.download = `${safeName}-${measure.version}-mat.xml`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.URL.revokeObjectURL(url);
      emitToast("MAT export downloaded");
    } catch (err) {
      onError(err instanceof Error ? err.message : "MAT export failed");
    } finally {
      setExportingMat(false);
    }
  }

  return (
    <>
      <div className="grid gap-3 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Readiness Checklist</h3>
        <div className="grid gap-2 text-sm">
          <p>Compile Status: <span className={compileReady ? "text-emerald-700" : "text-red-700"}>{compileReady ? "✅" : "❌"} {formatStatusLabel(activationReadiness?.compileStatus ?? "UNKNOWN")}</span></p>
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
        <ValueSetGovernancePanel measureId={measureId} api={api} />

        <h3 className="mt-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">Version History</h3>
        {versionHistory.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">No versions found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
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
                  <tr key={entry.id} className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className="px-2 py-1">{entry.version}</td>
                    <td className="px-2 py-1"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${measureStatusClass(entry.status)}`}>{formatStatusLabel(entry.status)}</span></td>
                    <td className="px-2 py-1">{entry.author}</td>
                    <td className="px-2 py-1">{new Date(entry.createdAt).toLocaleDateString()}</td>
                    <td className="px-2 py-1">{entry.changeSummary || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {measureVersionId ? (
          <div className="mt-2 flex flex-wrap items-center justify-start gap-2">
            <AuditPacketExportButton
              api={api}
              path={`/api/auditor/measure-versions/${measureVersionId}/packet`}
              filenamePrefix={`workwell-measure-version-packet-${measureVersionId}`}
              label="Export Measure Audit Packet"
              onError={(message) => onError(message)}
            />
            {canApprove ? (
              <button
                type="button"
                onClick={() => void exportMatBundle()}
                disabled={exportingMat}
                className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-neutral-800 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 disabled:opacity-60"
              >
                {exportingMat ? "Exporting MAT..." : "Export for MAT (FHIR XML)"}
              </button>
            ) : null}
          </div>
        ) : null}

        {normalizeEnumValue(measure.status) === "DRAFT" && canApprove ? (
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

        {normalizeEnumValue(measure.status) === "APPROVED" && canApprove ? (
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

        {normalizeEnumValue(measure.status) === "ACTIVE" && canAdminDeprecate ? (
          <div className="mt-2">
            <button className="rounded-md bg-neutral-700 px-3 py-2 text-xs font-semibold text-white" onClick={() => setShowDeprecateConfirm(true)}>
              Deprecate
            </button>
          </div>
        ) : null}
      </div>

      {showApproveConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50">
          <div className="w-full max-w-lg rounded-lg bg-white dark:bg-neutral-900 p-4">
            <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">Approve for Release</h3>
            <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">Confirm approval with checklist summary below:</p>
            <ul className="mt-2 list-disc pl-5 text-sm text-neutral-700 dark:text-neutral-300">
              <li>Compile: {formatStatusLabel(activationReadiness?.compileStatus ?? "UNKNOWN")}</li>
              <li>Fixtures Valid: {testsReady ? "Yes" : "No"}</li>
              <li>Value Sets Attached: {hasValueSets ? "Yes" : "No"}</li>
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-xs font-semibold" onClick={() => setShowApproveConfirm(false)}>Cancel</button>
              <button
                className="flex items-center gap-1 rounded bg-blue-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                onClick={approve}
                disabled={approving}
              >
                {approving ? (
                  <>
                    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Approving…
                  </>
                ) : (
                  "Confirm"
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showActivateConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50">
          <div className="w-full max-w-lg rounded-lg bg-white dark:bg-neutral-900 p-4">
            <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">Activate Measure</h3>
            <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">Activating this version replaces any currently Active version.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-xs font-semibold" onClick={() => setShowActivateConfirm(false)}>Cancel</button>
              <button
                className="flex items-center gap-1 rounded bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                onClick={activate}
                disabled={activating}
              >
                {activating ? (
                  <>
                    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Activating…
                  </>
                ) : (
                  "Confirm Activate"
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showDeprecateConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50">
          <div className="w-full max-w-lg rounded-lg bg-white dark:bg-neutral-900 p-4">
            <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">Deprecate Measure</h3>
            <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">Deprecation reason is required.</p>
            <textarea
              className="mt-2 min-h-24 w-full rounded border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm"
              placeholder="Enter deprecation reason..."
              value={deprecateReason}
              onChange={(e) => setDeprecateReason(e.target.value)}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-xs font-semibold" onClick={() => setShowDeprecateConfirm(false)}>Cancel</button>
              <button
                className="flex items-center gap-1 rounded bg-neutral-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                onClick={deprecate}
                disabled={deprecating}
              >
                {deprecating ? (
                  <>
                    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Deprecating…
                  </>
                ) : (
                  "Confirm Deprecate"
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
