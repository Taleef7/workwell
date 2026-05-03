"use client";

import Link from "next/link";
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
};

export default function StudioMeasurePage({ params }: { params: { id: string } }) {
  const apiBase = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
    return raw.trim().replace(/\/+$/, "");
  }, []);
  const [tab, setTab] = useState<"spec" | "cql">("spec");
  const [measure, setMeasure] = useState<MeasureDetail | null>(null);
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

  const loadMeasure = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/measures/${params.id}`, { cache: "no-store" });
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
      setCompileErrors([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [apiBase, params.id]);

  useEffect(() => {
    if (apiBase) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadMeasure();
    }
  }, [apiBase, loadMeasure]);

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

    const response = await fetch(`${apiBase}/api/measures/${params.id}/spec`, {
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

  async function compileCql() {
    setError(null);
    const response = await fetch(`${apiBase}/api/measures/${params.id}/cql/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cqlText })
    });
    const payload = (await response.json()) as { status: string; errors?: string[] };
    if (!response.ok) {
      setError(`Compile failed (${response.status})`);
      return;
    }
    setCompileErrors(payload.errors ?? []);
    await loadMeasure();
  }

  async function transition(targetStatus: "Approved" | "Active" | "Deprecated") {
    setError(null);
    const response = await fetch(`${apiBase}/api/measures/${params.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetStatus })
    });
    if (!response.ok) {
      const message = await response.text();
      setError(message || `Status update failed (${response.status})`);
      return;
    }
    await loadMeasure();
  }

  function statusClass(status: string): string {
    if (status === "Draft") return "bg-slate-100 text-slate-700";
    if (status === "Approved") return "bg-blue-100 text-blue-700";
    if (status === "Active") return "bg-emerald-100 text-emerald-700";
    return "bg-slate-200 text-slate-700";
  }

  const canActivate = measure?.compileStatus === "COMPILED";

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
            <button
              className="rounded-md bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => transition("Active")}
              disabled={!canActivate}
              title={!canActivate ? "Compile CQL before activating." : "Activate"}
            >
              Activate
            </button>
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
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {toast ? <div className="fixed right-4 top-4 rounded bg-emerald-700 px-3 py-2 text-xs font-medium text-white">{toast}</div> : null}
      {loading ? <p className="text-sm text-slate-600">Loading...</p> : null}

      {tab === "spec" ? (
        <div className="grid gap-3 rounded-md border border-slate-200 bg-white p-4">
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
    </section>
  );
}
