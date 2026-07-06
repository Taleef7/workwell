"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { MEASURE_STATUS_LABELS, formatStatusLabel, labelFor, measureStatusClass, normalizeEnumValue } from "@/lib/status";
import { emitToast } from "@/lib/toast";
import { useAuth } from "@/components/auth-provider";
import { canApproveMeasures, canAuthorMeasures, isAdmin } from "@/lib/rbac";
import { useApi } from "@/lib/api/hooks";
import { useMeasureDetail } from "@/features/studio/hooks/useMeasureDetail";
import { useValueSets } from "@/features/studio/hooks/useValueSets";
import { useOshaReferences } from "@/features/studio/hooks/useOshaReferences";
import { AuditPacketExportButton } from "@/components/audit-packet-export-button";
import { VersionActions } from "@/features/studio/components/VersionActions";
import { SpecTab } from "@/features/studio/components/SpecTab";
import { CqlTab } from "@/features/studio/components/CqlTab";
import { RuleBuilderTab } from "@/features/studio/components/RuleBuilderTab";
import { ValueSetsTab } from "@/features/studio/components/ValueSetsTab";
import { TestsTab } from "@/features/studio/components/TestsTab";
import { ReleaseApprovalTab } from "@/features/studio/components/ReleaseApprovalTab";
import { TraceabilityTab } from "@/features/studio/components/TraceabilityTab";
import { StandardsTab } from "@/features/studio/components/StandardsTab";

type Tab = "spec" | "cql" | "rules" | "valuesets" | "tests" | "release" | "traceability" | "standards";

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

  const tabs: Tab[] = ["spec", "cql", "rules", "valuesets", "tests", "release", "traceability", "standards"];
  const tabLabels: Record<Tab, string> = { spec: "Spec", cql: "CQL", rules: "Rule Builder", valuesets: "Value Sets", tests: "Tests", release: "Release & Approval", traceability: "Traceability", standards: "Standards" };
  const tablistRef = useRef<HTMLDivElement>(null);

  // Roving-tabindex arrow-key navigation across the tab strip (WCAG ARIA tabs pattern), MANUAL
  // activation (Fable H11): arrow keys move FOCUS only — they no longer switch the active tab. Switching
  // tabs unmounts the current tabpanel and discards its unsaved authoring draft (Spec/Rule/Tests state is
  // component-local), so auto-activating on ArrowLeft/Right meant a single accidental keystroke destroyed
  // an author's in-progress work with no warning. The user now confirms the switch with Enter/Space/click
  // (the tab button's onClick), which is the WCAG-recommended manual-activation pattern for tabs whose
  // panels hold significant/at-risk content.
  function onTabKeyDown(e: React.KeyboardEvent, index: number) {
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    const nextTab = tabs[next];
    tablistRef.current?.querySelector<HTMLButtonElement>(`#studio-tab-${nextTab}`)?.focus();
  }

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
          {/* The measure-version audit packet endpoint is [APPROVER,A]; an AUTHOR saw the button and got
              a guaranteed 403 (Fable H10). Gate it by canApprove. */}
          {measure && canApprove ? (
            <AuditPacketExportButton
              api={api}
              path={currentMeasureVersionId ? `/api/auditor/measure-versions/${currentMeasureVersionId}/packet` : ""}
              filenamePrefix={`workwell-measure-version-packet-${currentMeasureVersionId ?? measureId}`}
              label="Export Measure Audit Packet"
              disabled={!currentMeasureVersionId}
              onError={(message) => setError(message || null)}
            />
          ) : null}
          {/* UX-15: the version-related controls (change summary + New Version clone) are grouped into
              a single "Version actions" dropdown menu so they read as one unit instead of scattered
              header items. Behaviour, validation ("required" lives in createNewVersion), and role-gating
              (canClone) are unchanged. */}
          <VersionActions
            version={measure?.version}
            statusLabel={measure ? labelFor(MEASURE_STATUS_LABELS, measure.status) : undefined}
            canClone={canClone}
            changeSummary={changeSummary}
            onChangeSummaryChange={setChangeSummary}
            onCreateNewVersion={createNewVersion}
          />
        </div>
      </div>

      <div ref={tablistRef} role="tablist" aria-label="Measure authoring sections" className="flex gap-2">
        {tabs.map((t, i) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`studio-tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`studio-tabpanel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            onKeyDown={(e) => onTabKeyDown(e, i)}
            className={`rounded-md px-3 py-2 text-sm ${tab === t ? "bg-neutral-900 text-white" : "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300"}`}
            onClick={() => setTab(t)}
          >
            {tabLabels[t]}
          </button>
        ))}
      </div>

      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {!measureId ? <p role="alert" className="text-sm text-red-700">Invalid measure route ID.</p> : null}
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
        <div role="tabpanel" id="studio-tabpanel-spec" aria-labelledby="studio-tab-spec">
        <SpecTab
          measure={measure}
          measureId={measureId}
          api={api}
          oshaReferences={oshaReferences}
          onSaved={load}
          onError={(msg) => setError(msg || null)}
          canAuthor={canClone}
        />
        </div>
      ) : null}

      {measure && tab === "cql" ? (
        <div role="tabpanel" id="studio-tabpanel-cql" aria-labelledby="studio-tab-cql">
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
          canAuthor={canClone}
          liveCompileStatus={liveCompileStatus}
          onCompileStatusChange={setLiveCompileStatus}
        />
        </div>
      ) : null}

      {measure && tab === "rules" ? (
        <div role="tabpanel" id="studio-tabpanel-rules" aria-labelledby="studio-tab-rules">
        <RuleBuilderTab measure={measure} measureId={measureId} api={api} onSaved={load} onError={(msg) => setError(msg || null)} canAuthor={canClone} />
        </div>
      ) : null}

      {measure && tab === "valuesets" ? (
        <div role="tabpanel" id="studio-tabpanel-valuesets" aria-labelledby="studio-tab-valuesets">
        <ValueSetsTab
          measure={measure}
          measureId={measureId}
          api={api}
          allValueSets={allValueSets}
          onChanged={load}
          onValueSetsChanged={loadValueSets}
          onError={(msg) => setError(msg || null)}
        />
        </div>
      ) : null}

      {measure && tab === "tests" ? (
        <div role="tabpanel" id="studio-tabpanel-tests" aria-labelledby="studio-tab-tests">
        <TestsTab
          measureId={measureId}
          api={api}
          initialFixtures={measure.testFixtures ?? []}
          onSaved={load}
          onError={(msg) => setError(msg || null)}
          canAuthor={canClone}
        />
        </div>
      ) : null}

      {measure && tab === "release" ? (
        <div role="tabpanel" id="studio-tabpanel-release" aria-labelledby="studio-tab-release">
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
        </div>
      ) : null}

      {measureId && tab === "traceability" ? (
        <div role="tabpanel" id="studio-tabpanel-traceability" aria-labelledby="studio-tab-traceability">
        <TraceabilityTab measureId={measureId} api={api} />
        </div>
      ) : null}

      {measureId && tab === "standards" ? (
        <div role="tabpanel" id="studio-tabpanel-standards" aria-labelledby="studio-tab-standards">
        <StandardsTab measureId={measureId} api={api} />
        </div>
      ) : null}
      </div>
    </section>
  );
}
