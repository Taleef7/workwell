"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, useEffect, useCallback, useRef } from "react";
import type { Monaco, OnChange, OnMount } from "@monaco-editor/react";
import { measureStatusClass } from "@/lib/status";
import { emitToast } from "@/lib/toast";
import { useAuth } from "@/components/auth-provider";
import { useApi } from "@/lib/api/hooks";
import { OshaReferenceCombobox, type OshaReferenceOption } from "@/components/osha-reference-combobox";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[400px] items-center justify-center rounded-md border border-slate-200 bg-slate-950 text-sm text-slate-200">
      Loading editor...
    </div>
  )
});

const BACKEND_MARKER_OWNER = "backend-compile";

type MeasureDetail = {
  id: string;
  name: string;
  policyRef: string;
  oshaReferenceId: string | null;
  version: string;
  status: "Draft" | "Approved" | "Active" | "Deprecated" | string;
  owner: string;
  description: string;
  eligibilityCriteria: {
    roleFilter: string;
    siteFilter: string;
    programEnrollmentText: string;
  };
  exclusions: Array<{ label: string; criteriaText: string }>;
  complianceWindow: string;
  requiredDataElements: string[];
  cqlText: string;
  compileStatus: "COMPILED" | "ERROR" | string;
  valueSets: ValueSetRef[];
  testFixtures: TestFixture[];
};

type ValueSetRef = {
  id: string;
  oid: string;
  name: string;
  version: string;
  resolvabilityStatus: "RESOLVED" | "UNRESOLVED" | string;
  resolvabilityLabel: string;
  resolvabilityNote: string;
  codeCount: number;
};

type OshaReference = OshaReferenceOption;

type TestFixture = {
  fixtureName: string;
  employeeExternalId: string;
  expectedOutcome: string;
  notes: string;
};

type ActivationReadiness = {
  ready: boolean;
  compileStatus: string;
  testFixtureCount: number;
  valueSetCount: number;
  testValidationPassed: boolean;
  activationBlockers: string[];
};

type VersionHistoryItem = {
  id: string;
  version: string;
  status: "Draft" | "Approved" | "Active" | "Deprecated" | string;
  author: string;
  createdAt: string;
  changeSummary: string;
};

type DraftSpecResponse = {
  success: boolean;
  fallback?: string | null;
  suggestion: {
    description?: string;
    eligibilityCriteria?: {
      roleFilter?: string;
      siteFilter?: string;
      programEnrollmentText?: string;
    };
    exclusions?: Array<{ label?: string; criteriaText?: string }>;
    complianceWindow?: string;
    requiredDataElements?: string[];
  };
};

export default function StudioMeasurePage() {
  const { user } = useAuth();
  const api = useApi();
  const params = useParams<{ id: string }>();
  const measureId = typeof params?.id === "string" ? params.id : "";
  const [tab, setTab] = useState<"spec" | "cql" | "valuesets" | "tests" | "release">("spec");
  const [measure, setMeasure] = useState<MeasureDetail | null>(null);
  const [allValueSets, setAllValueSets] = useState<ValueSetRef[]>([]);
  const [oshaReferences, setOshaReferences] = useState<OshaReference[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compileWarnings, setCompileWarnings] = useState<string[]>([]);
  const [compileErrors, setCompileErrors] = useState<string[]>([]);

  const [policyRef, setPolicyRef] = useState("");
  const [oshaReferenceId, setOshaReferenceId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [siteFilter, setSiteFilter] = useState("");
  const [programEnrollmentText, setProgramEnrollmentText] = useState("");
  const [exclusionLabel, setExclusionLabel] = useState("");
  const [exclusionCriteria, setExclusionCriteria] = useState("");
  const [complianceWindow, setComplianceWindow] = useState("");
  const [requiredDataElementsText, setRequiredDataElementsText] = useState("");
  const [cqlText, setCqlText] = useState("");
  const [valueSetOid, setValueSetOid] = useState("");
  const [valueSetName, setValueSetName] = useState("");
  const [valueSetVersion, setValueSetVersion] = useState("");
  const [testFixtures, setTestFixtures] = useState<TestFixture[]>([]);
  const [testFailures, setTestFailures] = useState<string[]>([]);
  const [activationReadiness, setActivationReadiness] = useState<ActivationReadiness | null>(null);
  const [versionHistory, setVersionHistory] = useState<VersionHistoryItem[]>([]);
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);
  const [showActivateConfirm, setShowActivateConfirm] = useState(false);
  const [showDeprecateConfirm, setShowDeprecateConfirm] = useState(false);
  const [deprecateReason, setDeprecateReason] = useState("");
  const [policyText, setPolicyText] = useState("");
  const [aiDraftBanner, setAiDraftBanner] = useState<string | null>(null);
  const [changeSummary, setChangeSummary] = useState("");
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  const loadMeasure = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<MeasureDetail>(`/api/measures/${measureId}`);
      setMeasure(data);
      setPolicyRef(data.policyRef ?? "");
      setOshaReferenceId(data.oshaReferenceId ?? null);
      setDescription(data.description ?? "");
      setRoleFilter(data.eligibilityCriteria?.roleFilter ?? "");
      setSiteFilter(data.eligibilityCriteria?.siteFilter ?? "");
      setProgramEnrollmentText(data.eligibilityCriteria?.programEnrollmentText ?? "");
      setExclusionLabel(data.exclusions?.[0]?.label ?? "");
      setExclusionCriteria(data.exclusions?.[0]?.criteriaText ?? "");
      setComplianceWindow(data.complianceWindow ?? "");
      setRequiredDataElementsText((data.requiredDataElements ?? []).join("\n"));
      setCqlText(data.cqlText ?? "");
      setTestFixtures(data.testFixtures ?? []);
      try {
        const readiness = await api.get<ActivationReadiness>(`/api/measures/${measureId}/activation-readiness`);
        setActivationReadiness(readiness);
      } catch {
        // non-fatal
      }
      try {
        const versions = await api.get<VersionHistoryItem[]>(`/api/measures/${measureId}/versions`);
        setVersionHistory(versions);
      } catch {
        // non-fatal
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [api, measureId]);

  const loadValueSets = useCallback(async () => {
    try {
      const data = await api.get<ValueSetRef[]>("/api/value-sets");
      setAllValueSets(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [api]);

  const loadOshaReferences = useCallback(async () => {
    try {
      const data = await api.get<OshaReference[]>("/api/osha-references");
      setOshaReferences(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [api]);

  useEffect(() => {
    if (measureId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadMeasure();
      void loadValueSets();
      void loadOshaReferences();
    }
  }, [measureId, loadMeasure, loadValueSets, loadOshaReferences]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCompileWarnings([]);
      setCompileErrors([]);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [measureId]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel?.();
    if (!editor || !monaco || !model) {
      return;
    }

    const markers = compileErrors
      .map(parseCompileIssue)
      .filter((issue): issue is ParsedCompileIssue => issue !== null)
      .map((issue) => ({
        severity: monaco.MarkerSeverity.Error,
        message: issue.message,
        startLineNumber: issue.line,
        startColumn: issue.column,
        endLineNumber: issue.line,
        endColumn: issue.column + 1
      }));

    monaco.editor.setModelMarkers(model, BACKEND_MARKER_OWNER, markers);
  }, [compileErrors]);

  async function saveSpec() {
    setError(null);
    if (!policyRef.trim()) {
      setError("Policy reference is required.");
      return;
    }
    const requiredDataElements = requiredDataElementsText
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);

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
      await loadMeasure();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Spec save failed");
    }
  }

  async function draftSpecWithAi() {
    setError(null);
    setAiDraftBanner(null);
    try {
      const payload = await api.post<object, DraftSpecResponse>(`/api/measures/${measureId}/ai/draft-spec`, {
        measureName: measure?.name ?? "",
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
      setError(err instanceof Error ? err.message : "AI draft failed");
    }
  }

  async function compileCql() {
    setError(null);
    try {
      const payload = await api.post<object, { status: string; errors?: string[]; warnings?: string[] }>(
        `/api/measures/${measureId}/cql/compile`,
        { cqlText }
      );
      setCompileWarnings(payload.warnings ?? []);
      setCompileErrors(payload.errors ?? []);
      if ((payload.errors ?? []).length === 0) {
        emitToast("CQL compiled successfully");
      }
      await loadMeasure();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Compile failed");
    }
  }

  const handleCqlMount = useCallback<OnMount>((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    const model = editor?.getModel?.();
    if (!model) {
      return;
    }

    const markers = compileErrors
      .map(parseCompileIssue)
      .filter((issue): issue is ParsedCompileIssue => issue !== null)
      .map((issue) => ({
        severity: monaco.MarkerSeverity.Error,
        message: issue.message,
        startLineNumber: issue.line,
        startColumn: issue.column,
        endLineNumber: issue.line,
        endColumn: issue.column + 1
      }));

    monaco.editor.setModelMarkers(model, BACKEND_MARKER_OWNER, markers);
  }, [compileErrors]);

  const handleCqlChange = useCallback<OnChange>((value) => {
    setCqlText(value ?? "");
    setCompileWarnings([]);
    setCompileErrors([]);
  }, []);

  async function createValueSet() {
    setError(null);
    try {
      await api.post("/api/value-sets", { oid: valueSetOid, name: valueSetName, version: valueSetVersion });
      setValueSetOid("");
      setValueSetName("");
      setValueSetVersion("");
      await loadValueSets();
      emitToast("Value set created");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Value set create failed");
    }
  }

  async function attachValueSet(valueSetId: string) {
    setError(null);
    try {
      await api.post(`/api/measures/${measureId}/value-sets/${valueSetId}`);
      await loadMeasure();
      emitToast("Value set attached");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Value set link failed");
    }
  }

  async function detachValueSet(valueSetId: string) {
    setError(null);
    try {
      await api.delete(`/api/measures/${measureId}/value-sets/${valueSetId}`);
      await loadMeasure();
      emitToast("Value set removed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Value set unlink failed");
    }
  }

  async function approveForRelease() {
    setError(null);
    try {
      await api.post(`/api/measures/${measureId}/approve`);
      setShowApproveConfirm(false);
      emitToast("Measure approved for release");
      await loadMeasure();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approve failed");
    }
  }

  async function activateMeasure() {
    setError(null);
    try {
      await api.post(`/api/measures/${measureId}/status`, { targetStatus: "Active" });
      setShowActivateConfirm(false);
      emitToast("Measure activated");
      await loadMeasure();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Activation failed");
    }
  }

  async function deprecateMeasure() {
    setError(null);
    if (!deprecateReason.trim()) {
      setError("Deprecation reason is required.");
      return;
    }
    try {
      await api.post(`/api/measures/${measureId}/deprecate`, { reason: deprecateReason.trim() });
      setShowDeprecateConfirm(false);
      setDeprecateReason("");
      emitToast("Measure deprecated");
      await loadMeasure();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deprecation failed");
    }
  }

  async function saveTests() {
    setError(null);
    try {
      await api.put(`/api/measures/${measureId}/tests`, { fixtures: testFixtures });
      emitToast("Test fixtures saved");
      await loadMeasure();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tests save failed");
    }
  }

  async function createNewVersion() {
    setError(null);
    if (!changeSummary.trim()) {
      setError("Change summary is required to create a new version.");
      return;
    }
    try {
      await api.post(`/api/measures/${measureId}/versions`, { changeSummary: changeSummary.trim() });
      setChangeSummary("");
      emitToast("New draft version created");
      await loadMeasure();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Version clone failed");
    }
  }

  async function validateTests() {
    setError(null);
    try {
      const payload = await api.post<undefined, { passed: boolean; failures: string[] }>(`/api/measures/${measureId}/tests/validate`);
      setTestFailures(payload.failures ?? []);
      emitToast(payload.passed ? "Test fixtures are valid" : "Test fixtures need fixes");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test validation failed");
    }
  }

  function updateFixture(index: number, field: keyof TestFixture, value: string) {
    setTestFixtures((current) => current.map((fixture, i) => (i === index ? { ...fixture, [field]: value } : fixture)));
  }

  function addFixture() {
    setTestFixtures((current) => [...current, { fixtureName: "", employeeExternalId: "", expectedOutcome: "COMPLIANT", notes: "" }]);
  }

  function removeFixture(index: number) {
    setTestFixtures((current) => current.filter((_, i) => i !== index));
  }

  const canActivate = activationReadiness?.ready ?? false;
  const canClone = user?.role === "ROLE_AUTHOR";
  const canApprove = user?.role === "ROLE_APPROVER" || user?.role === "ROLE_ADMIN";
  const canAdminDeprecate = user?.role === "ROLE_ADMIN";
  const compileReady = !!activationReadiness && ["COMPILED", "WARNINGS"].includes((activationReadiness.compileStatus ?? "").toUpperCase());
  const testsReady = !!activationReadiness && activationReadiness.testValidationPassed;
  const hasValueSets = (measure?.valueSets?.length ?? 0) > 0;
  const unresolvedValueSets = (measure?.valueSets ?? []).filter((vs) => vs.resolvabilityStatus.toUpperCase() === "UNRESOLVED").length;
  const requiredSpecComplete =
    !!policyRef.trim() &&
    !!description.trim() &&
    !!roleFilter.trim() &&
    !!siteFilter.trim() &&
    !!programEnrollmentText.trim() &&
    !!complianceWindow.trim() &&
    requiredDataElementsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean).length > 0;
  const approveEnabled = compileReady && testsReady;
  const approveDisabledReason = !compileReady ? "Compile status must be COMPILED or WARNINGS." : !testsReady ? "Test fixtures must pass validation." : "";

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/measures" className="text-xs text-slate-500 hover:underline">
            Back to Measures
          </Link>
          <h2 className="text-2xl font-semibold">{measure?.name ?? "Measure Studio"}</h2>
          {measure ? (
            <p className="mt-1 text-sm text-slate-600">
              {measure.version} • <span className={`rounded-full px-2 py-1 text-xs font-medium ${measureStatusClass(measure.status)}`}>{measure.status}</span>
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          {canClone ? (
            <div className="flex items-center gap-2">
              <input
                className="rounded border border-slate-300 px-2 py-1 text-xs"
                placeholder="Change summary (required)"
                value={changeSummary}
                onChange={(e) => setChangeSummary(e.target.value)}
              />
              <button
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800"
                onClick={createNewVersion}
              >
                New Version
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex gap-2">
        <button className={`rounded-md px-3 py-2 text-sm ${tab === "spec" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`} onClick={() => setTab("spec")}>Spec</button>
        <button className={`rounded-md px-3 py-2 text-sm ${tab === "cql" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`} onClick={() => setTab("cql")}>CQL</button>
        <button className={`rounded-md px-3 py-2 text-sm ${tab === "valuesets" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`} onClick={() => setTab("valuesets")}>Value Sets</button>
        <button className={`rounded-md px-3 py-2 text-sm ${tab === "tests" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`} onClick={() => setTab("tests")}>Tests</button>
        <button className={`rounded-md px-3 py-2 text-sm ${tab === "release" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`} onClick={() => setTab("release")}>Release & Approval</button>
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {!measureId ? <p className="text-sm text-red-700">Invalid measure route ID.</p> : null}
      {loading ? <p className="text-sm text-slate-600">Loading...</p> : null}
      {measure?.status === "Approved" && activationReadiness ? (
        <div className="rounded-md border border-slate-200 bg-white p-3 text-sm">
          <p className="font-semibold text-slate-800">Activation Readiness</p>
          <p className="text-slate-700">Compile: {activationReadiness.compileStatus}</p>
          <p className="text-slate-700">Fixtures: {activationReadiness.testFixtureCount}</p>
          <p className="text-slate-700">Value Sets: {activationReadiness.valueSetCount}</p>
          {!activationReadiness.ready && activationReadiness.activationBlockers.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-red-700">
              {activationReadiness.activationBlockers.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-emerald-700">Ready for activation.</p>
          )}
        </div>
      ) : null}

      {tab === "spec" ? (
        <div className="grid gap-3 rounded-md border border-slate-200 bg-white p-4">
          {aiDraftBanner ? (
            <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">{aiDraftBanner}</p>
          ) : null}
          <textarea className="min-h-20 rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Paste policy text for AI draft..." value={policyText} onChange={(e) => setPolicyText(e.target.value)} />
          <div>
            <button className="rounded-md bg-blue-700 px-3 py-2 text-xs font-semibold text-white" onClick={draftSpecWithAi}>
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
            <button className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white" onClick={saveSpec}>
              Save Draft
            </button>
          </div>
        </div>
      ) : null}

      {tab === "cql" ? (
        <div className="grid gap-3 rounded-md border border-slate-200 bg-white p-4">
          <div className="overflow-hidden rounded border border-slate-300" style={{ minHeight: 400, height: "calc(100vh - 24rem)", maxHeight: "calc(100vh - 12rem)" }}>
            <MonacoEditor
              height="100%"
              language="sql"
              theme="vs-dark"
              value={cqlText}
              onMount={handleCqlMount}
              onChange={handleCqlChange}
              options={{
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 14,
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                wordWrap: "on"
              }}
              loading={<div className="flex h-full items-center justify-center bg-slate-950 text-sm text-slate-200">Loading editor...</div>}
            />
          </div>
          <div className="flex items-center gap-2">
            <button className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white" onClick={compileCql}>
              Compile
            </button>
            <span className={`rounded-full px-2 py-1 text-xs font-medium ${compileStatusClass(measure?.compileStatus ?? "")}`}>
              {measure?.compileStatus ?? "UNKNOWN"}
            </span>
          </div>
          {measure?.compileStatus === "WARNINGS" ? (
            <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
              Compile completed with warnings. Activation is allowed, but review warnings before moving to Active.
            </p>
          ) : null}
          {compileWarnings.length > 0 ? (
            <div className="rounded border border-amber-300 bg-amber-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-amber-800">Warnings</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
                {compileWarnings.map((entry) => (
                  <li key={entry}>{formatIssue(entry)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {compileErrors.length > 0 ? (
            <div className="rounded border border-red-300 bg-red-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-red-800">Errors</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-800">
                {compileErrors.map((entry) => (
                  <li key={entry}>{formatIssue(entry)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "valuesets" ? (
        <div className="grid gap-3 rounded-md border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">Attached Value Sets</h3>
          {measure?.valueSets?.length ? (
            <ul className="space-y-2">
              {measure.valueSets.map((valueSet) => (
                <li key={valueSet.id} className="flex items-center justify-between rounded border border-slate-200 px-3 py-2 text-sm">
                  <div>
                    <p className="font-medium text-slate-800">{valueSet.name}</p>
                    <p className="text-xs text-slate-600">{valueSet.oid} • {valueSet.version}</p>
                    <p className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${valueSetBadgeClass(valueSet.resolvabilityStatus)}`}>
                      {valueSet.resolvabilityLabel}
                    </p>
                    {valueSet.resolvabilityStatus === "UNRESOLVED" ? (
                      <p className="mt-1 text-xs text-amber-700">{valueSet.resolvabilityNote}</p>
                    ) : null}
                  </div>
                  <button className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700" onClick={() => detachValueSet(valueSet.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-600">No value sets attached yet.</p>
          )}

          <h3 className="mt-2 text-sm font-semibold text-slate-900">Create Value Set</h3>
          <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="OID (e.g., urn:oid:...)" value={valueSetOid} onChange={(e) => setValueSetOid(e.target.value)} />
          <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Name" value={valueSetName} onChange={(e) => setValueSetName(e.target.value)} />
          <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Version" value={valueSetVersion} onChange={(e) => setValueSetVersion(e.target.value)} />
          <div>
            <button className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white" onClick={createValueSet}>
              Create Value Set
            </button>
          </div>

          <h3 className="mt-2 text-sm font-semibold text-slate-900">Attach Existing Value Set</h3>
          {allValueSets.length ? (
            <ul className="space-y-2">
              {allValueSets
                .filter((valueSet) => !(measure?.valueSets ?? []).some((attached) => attached.id === valueSet.id))
                .map((valueSet) => (
                  <li key={valueSet.id} className="flex items-center justify-between rounded border border-slate-200 px-3 py-2 text-sm">
                    <div>
                      <p className="font-medium text-slate-800">{valueSet.name}</p>
                      <p className="text-xs text-slate-600">{valueSet.oid} • {valueSet.version}</p>
                      <p className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${valueSetBadgeClass(valueSet.resolvabilityStatus)}`}>
                        {valueSet.resolvabilityLabel}
                      </p>
                    </div>
                    <button className="rounded bg-blue-700 px-2 py-1 text-xs font-medium text-white" onClick={() => attachValueSet(valueSet.id)}>
                      Attach
                    </button>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-600">No value sets available yet.</p>
          )}
        </div>
      ) : null}

      {tab === "tests" ? (
        <div className="grid gap-3 rounded-md border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Fixture Validation</h3>
            <div className="flex gap-2">
              <button className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700" onClick={addFixture}>Add Fixture</button>
              <button className="rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white" onClick={saveTests}>Save Tests</button>
              <button className="rounded bg-blue-700 px-2 py-1 text-xs font-medium text-white" onClick={validateTests}>Validate</button>
            </div>
          </div>

          {testFixtures.length === 0 ? <p className="text-sm text-slate-600">No fixtures yet. Add at least one before activation.</p> : null}
          {testFixtures.map((fixture, index) => (
            <div key={`${fixture.fixtureName}-${index}`} className="grid gap-2 rounded border border-slate-200 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-700">Fixture {index + 1}</p>
                <button className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700" onClick={() => removeFixture(index)}>Remove</button>
              </div>
              <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Fixture Name" value={fixture.fixtureName} onChange={(e) => updateFixture(index, "fixtureName", e.target.value)} />
              <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Employee External ID" value={fixture.employeeExternalId} onChange={(e) => updateFixture(index, "employeeExternalId", e.target.value)} />
              <select className="rounded border border-slate-300 px-3 py-2 text-sm" value={fixture.expectedOutcome} onChange={(e) => updateFixture(index, "expectedOutcome", e.target.value)}>
                <option value="COMPLIANT">COMPLIANT</option>
                <option value="DUE_SOON">DUE_SOON</option>
                <option value="OVERDUE">OVERDUE</option>
                <option value="MISSING_DATA">MISSING_DATA</option>
                <option value="EXCLUDED">EXCLUDED</option>
              </select>
              <input className="rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Notes" value={fixture.notes} onChange={(e) => updateFixture(index, "notes", e.target.value)} />
            </div>
          ))}
          {testFailures.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-red-700">
              {testFailures.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {tab === "release" ? (
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

          {measure?.status === "Draft" && canApprove ? (
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

          {measure?.status === "Approved" && canApprove ? (
            <div className="mt-2">
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

          {measure?.status === "Active" && canAdminDeprecate ? (
            <div className="mt-2">
              <button className="rounded-md bg-slate-700 px-3 py-2 text-xs font-semibold text-white" onClick={() => setShowDeprecateConfirm(true)}>
                Deprecate
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

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
              <button className="rounded bg-blue-700 px-3 py-2 text-xs font-semibold text-white" onClick={approveForRelease}>Confirm</button>
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
              <button className="rounded bg-emerald-700 px-3 py-2 text-xs font-semibold text-white" onClick={activateMeasure}>Confirm Activate</button>
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
              <button className="rounded bg-slate-700 px-3 py-2 text-xs font-semibold text-white" onClick={deprecateMeasure}>Confirm Deprecate</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function compileStatusClass(status: string): string {
  const normalized = status.toUpperCase();
  if (normalized === "COMPILED") {
    return "bg-emerald-100 text-emerald-700";
  }
  if (normalized === "WARNINGS") {
    return "bg-amber-100 text-amber-800";
  }
  return "bg-red-100 text-red-700";
}

function formatIssue(issue: string): string {
  const parsed = parseCompileIssue(issue);
  if (!parsed) {
    return issue;
  }
  return `Line ${parsed.line}, Column ${parsed.column}: ${parsed.message}`;
}

function valueSetBadgeClass(status: string): string {
  const normalized = status.toUpperCase();
  if (normalized === "RESOLVED") {
    return "border border-emerald-300 bg-emerald-100 text-emerald-800";
  }
  return "border border-amber-300 bg-amber-100 text-amber-800";
}

type ParsedCompileIssue = {
  line: number;
  column: number;
  message: string;
};

function parseCompileIssue(issue: string): ParsedCompileIssue | null {
  const exactMatch = issue.match(/^Line\s+(\d+),\s+Column\s+(\d+):\s+(?:ERROR|WARNING):\s+(.*)$/i);
  if (exactMatch) {
    return {
      line: Number(exactMatch[1]),
      column: Number(exactMatch[2]),
      message: exactMatch[3]
    };
  }

  const locationMatch = issue.match(/line\s+(\d+)(?:,\s*column\s+(\d+))?/i) ?? issue.match(/\[(\d+):(\d+)\]/);
  if (!locationMatch) {
    return null;
  }

  return {
    line: Number(locationMatch[1]),
    column: Number(locationMatch[2] ?? 1),
    message: issue
  };
}
