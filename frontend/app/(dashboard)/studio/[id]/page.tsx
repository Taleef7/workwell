"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, useEffect } from "react";
import { Button, Input } from "@mieweb/ui";
import { MEASURE_STATUS_LABELS, formatStatusLabel, labelFor, measureStatusClass, normalizeEnumValue } from "@/lib/status";
import { emitToast } from "@/lib/toast";
import { useAuth } from "@/components/auth-provider";
import { canApproveMeasures, canAuthorMeasures, isAdmin } from "@/lib/rbac";
import { useApi } from "@/lib/api/hooks";
import { useMeasureDetail } from "@/features/studio/hooks/useMeasureDetail";
import { useValueSets } from "@/features/studio/hooks/useValueSets";
import { useOshaReferences } from "@/features/studio/hooks/useOshaReferences";
import { AuditPacketExportButton } from "@/components/audit-packet-export-button";
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
  const [liveCompileStatus, setLiveCompileStatus] = useState<string | null>(null);
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
    const timer = window.setTimeout(() => { setCompileErrors([]); setCompileWarnings([]); setLiveCompileStatus(null); }, 0);
    return () => window.clearTimeout(timer);
  }, [measureId]);

  async function createNewVersion(summaryOverride?: string): Promise<boolean> {
    const summary = (summaryOverride ?? changeSummary).trim();
    setError(null);
    if (!summary) {
      setError("Change summary is required to create a new version.");
      return false;
    }
    try {
      await api.post(`/api/measures/${measureId}/versions`, { changeSummary: summary });
      setChangeSummary("");
      emitToast("New draft version created");
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Version clone failed");
      return false;
    }
  }

  // Use the shared rbac helpers (mirror authorize.ts) instead of inline role string checks.
  const canClone = canAuthorMeasures(user?.role);
  const canApprove = canApproveMeasures(user?.role);
  const canActivate = activationReadiness?.ready ?? false;
  const canAdminDeprecate = isAdmin(user?.role);
  const currentMeasureVersionId =
    versionHistory.find((item) => item.version === measure?.version && normalizeEnumValue(item.status) === normalizeEnumValue(measure?.status ?? ""))?.id
    ?? versionHistory.find((item) => item.version === measure?.version)?.id
    ?? null;

  const tabs: Tab[] = ["spec", "cql", "valuesets", "tests", "release", "traceability"];
  const tabLabels: Record<Tab, string> = { spec: "Spec", cql: "CQL", valuesets: "Value Sets", tests: "Tests", release: "Release & Approval", traceability: "Traceability" };

  return (
    <section className="space-y-4">
      <div className="md:hidden rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">Studio</p>
        <h2 className="mt-2 text-lg font-semibold text-neutral-900 dark:text-neutral-100">Studio requires a larger screen</h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Open this page on a desktop or laptop to author CQL, manage value sets, and run release checks.
        </p>
      </div>

      <div className="hidden space-y-4 md:block">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/measures" className="text-xs text-neutral-500 dark:text-neutral-400 hover:underline">Back to Measures</Link>
          <h2 className="text-2xl font-semibold">{measure?.name ?? "Measure Studio"}</h2>
          {measure ? (
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              {measure.version} • <span className={`rounded-full px-2 py-1 text-xs font-medium ${measureStatusClass(measure.status)}`}>{labelFor(MEASURE_STATUS_LABELS, measure.status)}</span>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {measure ? (
            <AuditPacketExportButton
              api={api}
              path={currentMeasureVersionId ? `/api/auditor/measure-versions/${currentMeasureVersionId}/packet` : ""}
              filenamePrefix={`workwell-measure-version-packet-${currentMeasureVersionId ?? measureId}`}
              label="Export Measure Audit Packet"
              disabled={!currentMeasureVersionId}
              onError={(message) => setError(message || null)}
            />
          ) : null}
          {canClone ? (
            <>
            <Input
              label="Change summary"
              hideLabel
              placeholder="Change summary (required)"
              value={changeSummary}
              onChange={(e) => setChangeSummary(e.target.value)}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => void createNewVersion()}>
              New Version
            </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex gap-2">
        {tabs.map((t) => (
          <button key={t} className={`rounded-md px-3 py-2 text-sm ${tab === t ? "bg-neutral-900 text-white" : "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300"}`} onClick={() => setTab(t)}>
            {tabLabels[t]}
          </button>
        ))}
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {!measureId ? <p className="text-sm text-red-700">Invalid measure route ID.</p> : null}
      {loading ? <p className="text-sm text-neutral-600 dark:text-neutral-400">Loading...</p> : null}

      {normalizeEnumValue(measure?.status ?? "") === "APPROVED" && activationReadiness ? (
        <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 text-sm">
          <p className="font-semibold text-neutral-800 dark:text-neutral-200">Activation Readiness</p>
          <p className="text-neutral-700 dark:text-neutral-300">Compile: {formatStatusLabel(activationReadiness.compileStatus)}</p>
          <p className="text-neutral-700 dark:text-neutral-300">Fixtures: {activationReadiness.testFixtureCount}</p>
          <p className="text-neutral-700 dark:text-neutral-300">Value Sets: {activationReadiness.valueSetCount}</p>
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
          canClone={canClone}
          onCreateNewVersion={createNewVersion}
          liveCompileStatus={liveCompileStatus}
          onCompileStatusChange={setLiveCompileStatus}
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
      </div>
    </section>
  );
}
