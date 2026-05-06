"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState, useEffect, useCallback } from "react";

type MeasureDetail = {
  id: string;
  name: string;
  policyRef: string;
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
};

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
  const params = useParams<{ id: string }>();
  const measureId = typeof params?.id === "string" ? params.id : "";
  const apiBase = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
    return raw.trim().replace(/\/+$/, "");
  }, []);
  const [tab, setTab] = useState<"spec" | "cql" | "valuesets" | "tests">("spec");
  const [measure, setMeasure] = useState<MeasureDetail | null>(null);
  const [allValueSets, setAllValueSets] = useState<ValueSetRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [compileErrors, setCompileErrors] = useState<string[]>([]);

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
  const [policyText, setPolicyText] = useState("");
  const [aiDraftBanner, setAiDraftBanner] = useState<string | null>(null);

  const loadMeasure = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/measures/${measureId}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Failed to load measure (${response.status})`);
      const data = (await response.json()) as MeasureDetail;
      setMeasure(data);
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
      setCompileErrors([]);
      const readinessResponse = await fetch(`${apiBase}/api/measures/${measureId}/activation-readiness`, { cache: "no-store" });
      if (readinessResponse.ok) {
        const readiness = (await readinessResponse.json()) as ActivationReadiness;
        setActivationReadiness(readiness);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [apiBase, measureId]);

  const loadValueSets = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/api/value-sets`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Failed to load value sets (${response.status})`);
      const data = (await response.json()) as ValueSetRef[];
      setAllValueSets(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [apiBase]);

  useEffect(() => {
    if (apiBase && measureId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadMeasure();
      void loadValueSets();
    }
  }, [apiBase, measureId, loadMeasure, loadValueSets]);

  useEffect(() => {
    if (!toast) return;
    const handle = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(handle);
  }, [toast]);

  async function saveSpec() {
    setError(null);
    const requiredDataElements = requiredDataElementsText
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);

    const exclusions =
      exclusionLabel.trim() || exclusionCriteria.trim()
        ? [{ label: exclusionLabel.trim(), criteriaText: exclusionCriteria.trim() }]
        : [];

    const response = await fetch(`${apiBase}/api/measures/${measureId}/spec`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description,
        eligibilityCriteria: { roleFilter, siteFilter, programEnrollmentText },
        exclusions,
        complianceWindow,
        requiredDataElements
      })
    });

    if (!response.ok) {
      setError(`Spec save failed (${response.status})`);
      return;
    }
    setToast("Draft saved");
    await loadMeasure();
  }

  async function draftSpecWithAi() {
    setError(null);
    setAiDraftBanner(null);
    const response = await fetch(`${apiBase}/api/measures/${measureId}/ai/draft-spec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        measureName: measure?.name ?? "",
        policyText
      })
    });
    if (!response.ok) {
      setError(`AI draft failed (${response.status})`);
      return;
    }
    const payload = (await response.json()) as DraftSpecResponse;
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
    setToast("AI draft applied to spec form");
  }

  async function compileCql() {
    setError(null);
    const response = await fetch(`${apiBase}/api/measures/${measureId}/cql/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cqlText })
    });
    const payload = (await response.json()) as { status: string; errors?: string[]; warnings?: string[] };
    if (!response.ok) {
      setError(`Compile failed (${response.status})`);
      return;
    }
    setCompileErrors([...(payload.warnings ?? []), ...(payload.errors ?? [])]);
    await loadMeasure();
  }

  async function createValueSet() {
    setError(null);
    const response = await fetch(`${apiBase}/api/value-sets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oid: valueSetOid, name: valueSetName, version: valueSetVersion })
    });
    if (!response.ok) {
      setError(`Value set create failed (${response.status})`);
      return;
    }
    setValueSetOid("");
    setValueSetName("");
    setValueSetVersion("");
    await loadValueSets();
    setToast("Value set created");
  }

  async function attachValueSet(valueSetId: string) {
    setError(null);
    const response = await fetch(`${apiBase}/api/measures/${measureId}/value-sets/${valueSetId}`, {
      method: "POST"
    });
    if (!response.ok) {
      setError(`Value set link failed (${response.status})`);
      return;
    }
    await loadMeasure();
    setToast("Value set attached");
  }

  async function detachValueSet(valueSetId: string) {
    setError(null);
    const response = await fetch(`${apiBase}/api/measures/${measureId}/value-sets/${valueSetId}`, {
      method: "DELETE"
    });
    if (!response.ok) {
      setError(`Value set unlink failed (${response.status})`);
      return;
    }
    await loadMeasure();
    setToast("Value set removed");
  }

  async function transition(targetStatus: "Approved" | "Active" | "Deprecated") {
    setError(null);
    const response = await fetch(`${apiBase}/api/measures/${measureId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetStatus })
    });
    if (!response.ok) {
      const body = await response.text();
      setError(body || `Status update failed (${response.status})`);
      return;
    }
    await loadMeasure();
    setToast(`Status changed to ${targetStatus}`);
  }

  async function saveTests() {
    setError(null);
    const response = await fetch(`${apiBase}/api/measures/${measureId}/tests`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtures: testFixtures })
    });
    if (!response.ok) {
      setError(`Tests save failed (${response.status})`);
      return;
    }
    setToast("Test fixtures saved");
    await loadMeasure();
  }

  async function validateTests() {
    setError(null);
    const response = await fetch(`${apiBase}/api/measures/${measureId}/tests/validate`, {
      method: "POST"
    });
    if (!response.ok) {
      setError(`Test validation failed (${response.status})`);
      return;
    }
    const payload = (await response.json()) as { passed: boolean; failures: string[] };
    setTestFailures(payload.failures ?? []);
    setToast(payload.passed ? "Test fixtures are valid" : "Test fixtures need fixes");
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

  function statusClass(status: string): string {
    if (status === "Draft") return "bg-slate-100 text-slate-700";
    if (status === "Approved") return "bg-blue-100 text-blue-700";
    if (status === "Active") return "bg-emerald-100 text-emerald-700";
    return "bg-slate-200 text-slate-700";
  }

  const canActivate = activationReadiness?.ready ?? false;

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
              {measure.version} • <span className={`rounded-full px-2 py-1 text-xs font-medium ${statusClass(measure.status)}`}>{measure.status}</span>
            </p>
          ) : null}
        </div>
        <div>
          {measure?.status === "Draft" ? (
            <button className="rounded-md bg-blue-700 px-3 py-2 text-xs font-semibold text-white" onClick={() => transition("Approved")}>
              Submit for Approval
            </button>
          ) : null}
          {measure?.status === "Approved" ? (
            <div className="flex flex-col items-end gap-1">
              <button
                className="rounded-md bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => transition("Active")}
                disabled={!canActivate}
                title={!canActivate ? "Resolve blockers before activating." : "Activate"}
              >
                Activate
              </button>
              {!canActivate && activationReadiness?.activationBlockers?.length ? (
                <p className="text-xs text-amber-700">Blocked: {activationReadiness.activationBlockers[0]}</p>
              ) : null}
            </div>
          ) : null}
          {measure?.status === "Active" ? (
            <button className="rounded-md bg-slate-700 px-3 py-2 text-xs font-semibold text-white" onClick={() => transition("Deprecated")}>
              Deprecate
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex gap-2">
        <button className={`rounded-md px-3 py-2 text-sm ${tab === "spec" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`} onClick={() => setTab("spec")}>Spec</button>
        <button className={`rounded-md px-3 py-2 text-sm ${tab === "cql" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`} onClick={() => setTab("cql")}>CQL</button>
        <button className={`rounded-md px-3 py-2 text-sm ${tab === "valuesets" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`} onClick={() => setTab("valuesets")}>Value Sets</button>
        <button className={`rounded-md px-3 py-2 text-sm ${tab === "tests" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`} onClick={() => setTab("tests")}>Tests</button>
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {!measureId ? <p className="text-sm text-red-700">Invalid measure route ID.</p> : null}
      {toast ? <div className="fixed right-4 top-4 rounded bg-emerald-700 px-3 py-2 text-xs font-medium text-white">{toast}</div> : null}
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
          <textarea className="min-h-56 rounded border border-slate-300 px-3 py-2 font-mono text-sm" placeholder="Enter CQL here..." value={cqlText} onChange={(e) => setCqlText(e.target.value)} />
          <div className="flex items-center gap-2">
            <button className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white" onClick={compileCql}>
              Compile
            </button>
            <span className={`rounded-full px-2 py-1 text-xs font-medium ${measure?.compileStatus === "COMPILED" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
              {measure?.compileStatus === "COMPILED" ? "Compiled" : "Error"}
            </span>
          </div>
          {compileErrors.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-red-700">
              {compileErrors.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
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
    </section>
  );
}
