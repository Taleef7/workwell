"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, useEffect } from "react";
import { measureStatusClass } from "@/lib/status";
import { emitToast } from "@/lib/toast";
import { useAuth } from "@/components/auth-provider";
import { useApi } from "@/lib/api/hooks";
import { useMeasureDetail } from "@/features/studio/hooks/useMeasureDetail";
import { useValueSets } from "@/features/studio/hooks/useValueSets";
import { useOshaReferences } from "@/features/studio/hooks/useOshaReferences";
import { SpecTab } from "@/features/studio/components/SpecTab";
import { CqlTab } from "@/features/studio/components/CqlTab";
import { ValueSetsTab } from "@/features/studio/components/ValueSetsTab";
import { TestsTab } from "@/features/studio/components/TestsTab";
import { ReleaseApprovalTab } from "@/features/studio/components/ReleaseApprovalTab";
import { TraceabilityTab } from "@/features/studio/components/TraceabilityTab";

type Tab = "spec" | "cql" | "valuesets" | "tests" | "release" | "traceability";

export default function StudioMeasurePage() {
  const { user } = useAuth();
  const api = useApi();
  const params = useParams<{ id: string }>();
  const measureId = typeof params?.id === "string" ? params.id : "";

  const { measure, activationReadiness, versionHistory, loading, error, setError, load } = useMeasureDetail(api, measureId);
  const { allValueSets, load: loadValueSets } = useValueSets(api);
  const { oshaReferences, load: loadOshaReferences } = useOshaReferences(api);

  const [tab, setTab] = useState<Tab>("spec");
  const [cqlText, setCqlText] = useState(measure?.cqlText ?? "");
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [compileWarnings, setCompileWarnings] = useState<string[]>([]);
  const [changeSummary, setChangeSummary] = useState("");

  useEffect(() => {
    if (measureId) {
      void load();
      void loadValueSets();
      void loadOshaReferences();
    }
  }, [measureId, load, loadValueSets, loadOshaReferences]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (measure) setCqlText(measure.cqlText ?? "");
  }, [measure]);

  useEffect(() => {
    const timer = window.setTimeout(() => { setCompileErrors([]); setCompileWarnings([]); }, 0);
    return () => window.clearTimeout(timer);
  }, [measureId]);

  async function createNewVersion() {
    setError(null);
    if (!changeSummary.trim()) { setError("Change summary is required to create a new version."); return; }
    try {
      await api.post(`/api/measures/${measureId}/versions`, { changeSummary: changeSummary.trim() });
      setChangeSummary("");
      emitToast("New draft version created");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Version clone failed");
    }
  }

  const canClone = user?.role === "ROLE_AUTHOR";
  const canApprove = user?.role === "ROLE_APPROVER" || user?.role === "ROLE_ADMIN";
  const canActivate = activationReadiness?.ready ?? false;
  const canAdminDeprecate = user?.role === "ROLE_ADMIN";

  const tabs: Tab[] = ["spec", "cql", "valuesets", "tests", "release", "traceability"];
  const tabLabels: Record<Tab, string> = { spec: "Spec", cql: "CQL", valuesets: "Value Sets", tests: "Tests", release: "Release & Approval", traceability: "Traceability" };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/measures" className="text-xs text-slate-500 hover:underline">Back to Measures</Link>
          <h2 className="text-2xl font-semibold">{measure?.name ?? "Measure Studio"}</h2>
          {measure ? (
            <p className="mt-1 text-sm text-slate-600">
              {measure.version} • <span className={`rounded-full px-2 py-1 text-xs font-medium ${measureStatusClass(measure.status)}`}>{measure.status}</span>
            </p>
          ) : null}
        </div>
        {canClone ? (
          <div className="flex items-center gap-2">
            <input
              className="rounded border border-slate-300 px-2 py-1 text-xs"
              placeholder="Change summary (required)"
              value={changeSummary}
              onChange={(e) => setChangeSummary(e.target.value)}
            />
            <button className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800" onClick={createNewVersion}>
              New Version
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex gap-2">
        {tabs.map((t) => (
          <button key={t} className={`rounded-md px-3 py-2 text-sm ${tab === t ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`} onClick={() => setTab(t)}>
            {tabLabels[t]}
          </button>
        ))}
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
              {activationReadiness.activationBlockers.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : (
            <p className="mt-2 text-emerald-700">Ready for activation.</p>
          )}
        </div>
      ) : null}

      {measure && tab === "spec" ? (
        <SpecTab
          measure={measure}
          measureId={measureId}
          api={api}
          oshaReferences={oshaReferences}
          onSaved={load}
          onError={(msg) => setError(msg || null)}
        />
      ) : null}

      {measure && tab === "cql" ? (
        <CqlTab
          measure={measure}
          measureId={measureId}
          api={api}
          cqlText={cqlText}
          onCqlChange={setCqlText}
          compileErrors={compileErrors}
          compileWarnings={compileWarnings}
          onCompileErrors={setCompileErrors}
          onCompileWarnings={setCompileWarnings}
          onCompiled={load}
          onError={(msg) => setError(msg || null)}
        />
      ) : null}

      {measure && tab === "valuesets" ? (
        <ValueSetsTab
          measure={measure}
          measureId={measureId}
          api={api}
          allValueSets={allValueSets}
          onChanged={load}
          onValueSetsChanged={loadValueSets}
          onError={(msg) => setError(msg || null)}
        />
      ) : null}

      {measure && tab === "tests" ? (
        <TestsTab
          measureId={measureId}
          api={api}
          initialFixtures={measure.testFixtures ?? []}
          onSaved={load}
          onError={(msg) => setError(msg || null)}
        />
      ) : null}

      {measure && tab === "release" ? (
        <ReleaseApprovalTab
          measure={measure}
          measureId={measureId}
          api={api}
          activationReadiness={activationReadiness}
          versionHistory={versionHistory}
          canApprove={canApprove}
          canActivate={canActivate}
          canAdminDeprecate={canAdminDeprecate}
          onChanged={load}
          onError={(msg) => setError(msg || null)}
        />
      ) : null}

      {measureId && tab === "traceability" ? (
        <TraceabilityTab measureId={measureId} api={api} />
      ) : null}
    </section>
  );
}
