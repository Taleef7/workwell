"use client";

import { useState } from "react";
import { Button, Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle, Textarea } from "@mieweb/ui";
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
                  <th scope="col" className="px-2 py-1">Version</th>
                  <th scope="col" className="px-2 py-1">Status</th>
                  <th scope="col" className="px-2 py-1">Author</th>
                  <th scope="col" className="px-2 py-1">Created</th>
                  <th scope="col" className="px-2 py-1">Change Summary</th>
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void exportMatBundle()}
                disabled={exportingMat}
                isLoading={exportingMat}
                loadingText="Exporting MAT..."
              >
                Export for MAT (FHIR XML)
              </Button>
            ) : null}
          </div>
        ) : null}

        {normalizeEnumValue(measure.status) === "DRAFT" && canApprove ? (
          <div className="mt-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!approveEnabled}
              title={!approveEnabled ? approveDisabledReason : "Approve for release"}
              onClick={() => setShowApproveConfirm(true)}
            >
              Approve for Release
            </Button>
          </div>
        ) : null}

        {normalizeEnumValue(measure.status) === "APPROVED" && canApprove ? (
          <div className="mt-2 space-y-3">
            <ImpactPreviewPanel measureId={measureId} api={api} />
            <Button
              variant="primary"
              size="sm"
              disabled={!canActivate}
              title={!canActivate ? "Resolve blockers before activating." : "Activate measure"}
              onClick={() => setShowActivateConfirm(true)}
            >
              Activate Measure
            </Button>
          </div>
        ) : null}

        {normalizeEnumValue(measure.status) === "ACTIVE" && canAdminDeprecate ? (
          <div className="mt-2">
            <Button variant="secondary" size="sm" onClick={() => setShowDeprecateConfirm(true)}>
              Deprecate
            </Button>
          </div>
        ) : null}
      </div>

      <Modal open={showApproveConfirm} onOpenChange={(open) => { if (!open) setShowApproveConfirm(false); }} size="lg">
        <ModalHeader>
          <ModalTitle>Approve for Release</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">Confirm approval with checklist summary below:</p>
          <ul className="mt-2 list-disc pl-5 text-sm text-neutral-700 dark:text-neutral-300">
            <li>Compile: {formatStatusLabel(activationReadiness?.compileStatus ?? "UNKNOWN")}</li>
            <li>Fixtures Valid: {testsReady ? "Yes" : "No"}</li>
            <li>Value Sets Attached: {hasValueSets ? "Yes" : "No"}</li>
          </ul>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" size="sm" onClick={() => setShowApproveConfirm(false)}>Cancel</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={approve}
            disabled={approving}
            isLoading={approving}
            loadingText="Approving…"
          >
            Confirm
          </Button>
        </ModalFooter>
      </Modal>

      <Modal open={showActivateConfirm} onOpenChange={(open) => { if (!open) setShowActivateConfirm(false); }} size="lg">
        <ModalHeader>
          <ModalTitle>Activate Measure</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">Activating this version replaces any currently Active version.</p>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" size="sm" onClick={() => setShowActivateConfirm(false)}>Cancel</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={activate}
            disabled={activating}
            isLoading={activating}
            loadingText="Activating…"
          >
            Confirm Activate
          </Button>
        </ModalFooter>
      </Modal>

      <Modal open={showDeprecateConfirm} onOpenChange={(open) => { if (!open) setShowDeprecateConfirm(false); }} size="lg">
        <ModalHeader>
          <ModalTitle>Deprecate Measure</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">Deprecation reason is required.</p>
          <Textarea
            label="Deprecation reason"
            hideLabel
            className="mt-2 min-h-24"
            placeholder="Enter deprecation reason..."
            value={deprecateReason}
            onChange={(e) => setDeprecateReason(e.target.value)}
          />
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" size="sm" onClick={() => setShowDeprecateConfirm(false)}>Cancel</Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={deprecate}
            disabled={deprecating}
            isLoading={deprecating}
            loadingText="Deprecating…"
          >
            Confirm Deprecate
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
}
