"use client";

import { useState } from "react";
import { Button, Input, Textarea } from "@mieweb/ui";
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
  /** AUTHOR/ADMIN — spec save + AI draft are [AUTHOR,A] on the backend; a non-author (e.g. an APPROVER
   *  landing on this default tab) previously saw the controls and got a guaranteed 403 (Fable H10). */
  canAuthor: boolean;
};

export function SpecTab({ measure, measureId, api, oshaReferences, onSaved, onError, canAuthor }: Props) {
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
      <Textarea
        label="Policy text for AI draft"
        hideLabel
        className="min-h-20"
        placeholder="Paste policy text for AI draft..."
        value={policyText}
        onChange={(e) => setPolicyText(e.target.value)}
      />
      <div>
        <Button
          variant="primary"
          size="sm"
          onClick={draftWithAi}
          disabled={draftingSpec || !canAuthor}
          isLoading={draftingSpec}
          loadingText="Drafting…"
          title={canAuthor ? undefined : "Authoring requires the AUTHOR or ADMIN role"}
        >
          AI Draft Spec
        </Button>
      </div>
      <OshaReferenceCombobox
        value={policyRef}
        selectedReferenceId={oshaReferenceId}
        references={oshaReferences}
        onValueChange={setPolicyRef}
        onReferenceSelect={(reference) => setOshaReferenceId(reference?.id ?? null)}
      />
      <Textarea
        id="spec-description"
        label="Description"
        className="min-h-20"
        placeholder="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Input
        id="spec-role-filter"
        label="Eligibility Role Filter"
        placeholder="e.g., Safety Technician"
        value={roleFilter}
        onChange={(e) => setRoleFilter(e.target.value)}
      />
      <Input
        id="spec-site-filter"
        label="Eligibility Site Filter"
        placeholder="e.g., Plant A"
        value={siteFilter}
        onChange={(e) => setSiteFilter(e.target.value)}
      />
      <Input
        id="spec-program-enrollment"
        label="Program Enrollment Text"
        placeholder="e.g., In Hearing Conservation Program"
        value={programEnrollmentText}
        onChange={(e) => setProgramEnrollmentText(e.target.value)}
      />
      <Input
        id="spec-exclusion-label"
        label="Exclusion Label"
        placeholder="e.g., Active Waiver"
        value={exclusionLabel}
        onChange={(e) => setExclusionLabel(e.target.value)}
      />
      <Input
        id="spec-exclusion-criteria"
        label="Exclusion Criteria Text"
        placeholder="e.g., Has Active Waiver"
        value={exclusionCriteria}
        onChange={(e) => setExclusionCriteria(e.target.value)}
      />
      <Input
        id="spec-compliance-window"
        label="Compliance Window"
        placeholder="e.g., Annual"
        value={complianceWindow}
        onChange={(e) => setComplianceWindow(e.target.value)}
      />
      <Textarea
        id="spec-required-data-elements"
        label="Required Data Elements"
        className="min-h-24"
        placeholder="One per line"
        value={requiredDataElementsText}
        onChange={(e) => setRequiredDataElementsText(e.target.value)}
      />
      <div>
        <Button
          variant="primary"
          size="sm"
          onClick={save}
          disabled={savingSpec || !canAuthor}
          isLoading={savingSpec}
          loadingText="Saving…"
          title={canAuthor ? undefined : "Authoring requires the AUTHOR or ADMIN role"}
        >
          Save Draft
        </Button>
      </div>
    </div>
  );
}
