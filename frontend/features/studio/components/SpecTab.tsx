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
  const [savingSpec, setSavingSpec] = useState(false);
  const [draftingSpec, setDraftingSpec] = useState(false);

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
    setSavingSpec(true);
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
    } finally {
      setSavingSpec(false);
    }
  }

  async function draftWithAi() {
    onError("");
    setAiDraftBanner(null);
    setDraftingSpec(true);
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
    } finally {
      setDraftingSpec(false);
    }
  }

  return (
    <div className="grid gap-3 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      {aiDraftBanner ? (
        <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">{aiDraftBanner}</p>
      ) : null}
      <textarea
        className="min-h-20 rounded border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm"
        placeholder="Paste policy text for AI draft..."
        value={policyText}
        onChange={(e) => setPolicyText(e.target.value)}
      />
      <div>
        <button
          className="flex items-center gap-1 rounded-md bg-blue-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
          onClick={draftWithAi}
          disabled={draftingSpec}
        >
          {draftingSpec ? (
            <>
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Drafting…
            </>
          ) : (
            "AI Draft Spec"
          )}
        </button>
      </div>
      <OshaReferenceCombobox
        value={policyRef}
        selectedReferenceId={oshaReferenceId}
        references={oshaReferences}
        onValueChange={setPolicyRef}
        onReferenceSelect={(reference) => setOshaReferenceId(reference?.id ?? null)}
      />
      <div className="grid gap-1">
        <label htmlFor="spec-description" className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Description</label>
        <textarea id="spec-description" className="min-h-20 rounded border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <label htmlFor="spec-role-filter" className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Eligibility Role Filter</label>
        <input id="spec-role-filter" className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm" placeholder="e.g., Safety Technician" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <label htmlFor="spec-site-filter" className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Eligibility Site Filter</label>
        <input id="spec-site-filter" className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm" placeholder="e.g., Plant A" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <label htmlFor="spec-program-enrollment" className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Program Enrollment Text</label>
        <input id="spec-program-enrollment" className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm" placeholder="e.g., In Hearing Conservation Program" value={programEnrollmentText} onChange={(e) => setProgramEnrollmentText(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <label htmlFor="spec-exclusion-label" className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Exclusion Label</label>
        <input id="spec-exclusion-label" className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm" placeholder="e.g., Active Waiver" value={exclusionLabel} onChange={(e) => setExclusionLabel(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <label htmlFor="spec-exclusion-criteria" className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Exclusion Criteria Text</label>
        <input id="spec-exclusion-criteria" className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm" placeholder="e.g., Has Active Waiver" value={exclusionCriteria} onChange={(e) => setExclusionCriteria(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <label htmlFor="spec-compliance-window" className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Compliance Window</label>
        <input id="spec-compliance-window" className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm" placeholder="e.g., Annual" value={complianceWindow} onChange={(e) => setComplianceWindow(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <label htmlFor="spec-required-data-elements" className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Required Data Elements</label>
        <textarea id="spec-required-data-elements" className="min-h-24 rounded border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm" placeholder="One per line" value={requiredDataElementsText} onChange={(e) => setRequiredDataElementsText(e.target.value)} />
      </div>
      <div>
        <button
          className="flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
          onClick={save}
          disabled={savingSpec}
        >
          {savingSpec ? (
            <>
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Saving…
            </>
          ) : (
            "Save Draft"
          )}
        </button>
      </div>
    </div>
  );
}
