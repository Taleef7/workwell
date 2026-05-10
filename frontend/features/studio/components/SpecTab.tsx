"use client";

import { useState } from "react";
import { OshaReferenceCombobox } from "@/components/osha-reference-combobox";
import { emitToast } from "@/lib/toast";
import type { ApiClient } from "@/lib/api/client";
import type { MeasureDetail, OshaReference, DraftSpecResponse } from "../types";

type Props = {
  measure: MeasureDetail;
  measureId: string;
  api: ApiClient;
  oshaReferences: OshaReference[];
  onSaved: () => void;
  onError: (msg: string) => void;
};

export function SpecTab({ measure, measureId, api, oshaReferences, onSaved, onError }: Props) {
  const [policyRef, setPolicyRef] = useState(measure.policyRef ?? "");
  const [oshaReferenceId, setOshaReferenceId] = useState<string | null>(measure.oshaReferenceId ?? null);
  const [description, setDescription] = useState(measure.description ?? "");
  const [roleFilter, setRoleFilter] = useState(measure.eligibilityCriteria?.roleFilter ?? "");
  const [siteFilter, setSiteFilter] = useState(measure.eligibilityCriteria?.siteFilter ?? "");
  const [programEnrollmentText, setProgramEnrollmentText] = useState(measure.eligibilityCriteria?.programEnrollmentText ?? "");
  const [exclusionLabel, setExclusionLabel] = useState(measure.exclusions?.[0]?.label ?? "");
  const [exclusionCriteria, setExclusionCriteria] = useState(measure.exclusions?.[0]?.criteriaText ?? "");
  const [complianceWindow, setComplianceWindow] = useState(measure.complianceWindow ?? "");
  const [requiredDataElementsText, setRequiredDataElementsText] = useState((measure.requiredDataElements ?? []).join("\n"));
  const [policyText, setPolicyText] = useState("");
  const [aiDraftBanner, setAiDraftBanner] = useState<string | null>(null);

  async function save() {
    onError("");
    if (!policyRef.trim()) {
      onError("Policy reference is required.");
      return;
    }
    const requiredDataElements = requiredDataElementsText.split("\n").map((s) => s.trim()).filter(Boolean);
    const exclusions =
      exclusionLabel.trim() || exclusionCriteria.trim()
        ? [{ label: exclusionLabel.trim(), criteriaText: exclusionCriteria.trim() }]
        : [];
    try {
      await api.put(`/api/measures/${measureId}/spec`, {
        policyRef: policyRef.trim(),
        oshaReferenceId,
        description,
        eligibilityCriteria: { roleFilter, siteFilter, programEnrollmentText },
        exclusions,
        complianceWindow,
        requiredDataElements
      });
      emitToast("Spec saved");
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Spec save failed");
    }
  }

  async function draftWithAi() {
    onError("");
    setAiDraftBanner(null);
    try {
      const payload = await api.post<object, DraftSpecResponse>(`/api/measures/${measureId}/ai/draft-spec`, {
        measureName: measure.name,
        policyText
      });
      if (!payload.success) {
        setAiDraftBanner(payload.fallback ?? "AI temporarily unavailable. Please fill the spec manually.");
        return;
      }
      const suggestion = payload.suggestion ?? {};
      setDescription(suggestion.description ?? "");
      setRoleFilter(suggestion.eligibilityCriteria?.roleFilter ?? "");
      setSiteFilter(suggestion.eligibilityCriteria?.siteFilter ?? "");
      setProgramEnrollmentText(suggestion.eligibilityCriteria?.programEnrollmentText ?? "");
      setExclusionLabel(suggestion.exclusions?.[0]?.label ?? "");
      setExclusionCriteria(suggestion.exclusions?.[0]?.criteriaText ?? "");
      setComplianceWindow(suggestion.complianceWindow ?? "");
      setRequiredDataElementsText((suggestion.requiredDataElements ?? []).join("\n"));
      setAiDraftBanner("AI-generated draft - review and edit before saving.");
      emitToast("AI draft applied to spec form");
    } catch (err) {
      onError(err instanceof Error ? err.message : "AI draft failed");
    }
  }

  return (
    <div className="grid gap-3 rounded-md border border-slate-200 bg-white p-4">
      {aiDraftBanner ? (
        <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">{aiDraftBanner}</p>
      ) : null}
      <textarea
        className="min-h-20 rounded border border-slate-300 px-3 py-2 text-sm"
        placeholder="Paste policy text for AI draft..."
        value={policyText}
        onChange={(e) => setPolicyText(e.target.value)}
      />
      <div>
        <button className="rounded-md bg-blue-700 px-3 py-2 text-xs font-semibold text-white" onClick={draftWithAi}>
          AI Draft Spec
        </button>
      </div>
      <OshaReferenceCombobox
        value={policyRef}
        selectedReferenceId={oshaReferenceId}
        references={oshaReferences}
        onValueChange={setPolicyRef}
        onReferenceSelect={(reference) => setOshaReferenceId(reference?.id ?? null)}
      />
      <textarea className="min-h-20 rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Eligibility Role Filter" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} />
      <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Eligibility Site Filter" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} />
      <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Program Enrollment Text" value={programEnrollmentText} onChange={(e) => setProgramEnrollmentText(e.target.value)} />
      <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Exclusion Label" value={exclusionLabel} onChange={(e) => setExclusionLabel(e.target.value)} />
      <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Exclusion Criteria Text" value={exclusionCriteria} onChange={(e) => setExclusionCriteria(e.target.value)} />
      <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Compliance Window (e.g., Annual)" value={complianceWindow} onChange={(e) => setComplianceWindow(e.target.value)} />
      <textarea className="min-h-24 rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Required Data Elements (one per line)" value={requiredDataElementsText} onChange={(e) => setRequiredDataElementsText(e.target.value)} />
      <div>
        <button className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white" onClick={save}>
          Save Draft
        </button>
      </div>
    </div>
  );
}
