"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { ApiClient } from "@/lib/api/client";
import { emitToast } from "@/lib/toast";
import type { MeasureDetail, RuleParams, RuleBindings, RuleCodeBinding } from "../types";

type Props = {
  measure: MeasureDetail;
  measureId: string;
  api: ApiClient;
  onSaved: () => void;
  onError: (msg: string) => void;
};

type Shape = "series-completion" | "windowed-recency";

const emptyCode = (): RuleCodeBinding => ({ code: "", valueSet: "" });

export function RuleBuilderTab({ measure, measureId, api, onSaved, onError }: Props) {
  const r = measure.rule;
  const rb = measure.ruleBindings;
  const [shape, setShape] = useState<Shape>(r?.type ?? "series-completion");
  // series
  const [requiredDoses, setRequiredDoses] = useState<number>(r?.type === "series-completion" ? r.requiredDoses : 2);
  const [allowTiter, setAllowTiter] = useState<boolean>(r?.type === "series-completion" ? !!r.allowPositiveTiter : false);
  const [titer, setTiter] = useState<{ code: string; valueSet: string; minValue: number }>(rb?.titer ?? { code: "", valueSet: "", minValue: 1 });
  // windowed
  const [windowDays, setWindowDays] = useState<number>(r?.type === "windowed-recency" ? r.windowDays : 365);
  const [dueSoonDays, setDueSoonDays] = useState<number>(r?.type === "windowed-recency" ? r.dueSoonDays : 30);
  const [gracePeriodDays, setGracePeriodDays] = useState<number>(r?.type === "windowed-recency" ? (r.gracePeriodDays ?? 0) : 0);
  // bindings
  const [enrollment, setEnrollment] = useState<RuleCodeBinding>(rb?.enrollment ?? emptyCode());
  const [waiver, setWaiver] = useState<RuleCodeBinding>(rb?.waiver ?? emptyCode());
  const [eventCode, setEventCode] = useState<RuleCodeBinding>(rb?.event ? { code: rb.event.code, valueSet: rb.event.valueSet } : emptyCode());
  const [allowDeclination, setAllowDeclination] = useState<boolean>(!!rb?.refusal);
  const [refusal, setRefusal] = useState<RuleCodeBinding>(rb?.refusal ?? emptyCode());

  const [cql, setCql] = useState<string>("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const eventType: "procedure" | "immunization" | "observation" = shape === "series-completion" ? "immunization" : "procedure";

  const rule: RuleParams = useMemo(
    () =>
      shape === "series-completion"
        ? { type: "series-completion", requiredDoses, ...(allowTiter ? { allowPositiveTiter: true } : {}) }
        : { type: "windowed-recency", windowDays, dueSoonDays, ...(gracePeriodDays ? { gracePeriodDays } : {}) },
    [shape, requiredDoses, allowTiter, windowDays, dueSoonDays, gracePeriodDays]
  );
  const bindings: RuleBindings = useMemo(
    () => ({
      enrollment, waiver,
      event: { ...eventCode, type: eventType },
      ...(allowDeclination ? { refusal } : {}),
      ...(shape === "series-completion" && allowTiter ? { titer } : {}),
    }),
    [enrollment, waiver, eventCode, eventType, allowDeclination, refusal, shape, allowTiter, titer]
  );

  // Debounced live preview.
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const res = await api.post<{ rule: RuleParams; bindings: RuleBindings }, { cql: string }>(
          `/api/measures/${measureId}/rule/preview`, { rule, bindings }
        );
        setCql(res.cql);
        setPreviewError(null);
      } catch (e) {
        setPreviewError(e instanceof Error ? e.message : "Preview failed");
      }
    }, 400);
    return () => clearTimeout(t);
  }, [api, measureId, rule, bindings]);

  async function save() {
    onError("");
    setSaving(true);
    try {
      const res = await api.put<{ rule: RuleParams; bindings: RuleBindings }, { status: string; errors: string[] }>(
        `/api/measures/${measureId}/rule`, { rule, bindings }
      );
      emitToast(res.errors?.length ? `Saved with compile errors (${res.status})` : "Rule saved");
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Rule save failed");
    } finally {
      setSaving(false);
    }
  }

  const codeFields = (label: string, b: RuleCodeBinding, set: (v: RuleCodeBinding) => void) => (
    <div className="grid grid-cols-2 gap-2">
      <label className="flex flex-col text-xs">
        <span className="mb-1">{label} code</span>
        <input aria-label={`${label} code`} value={b.code} onChange={(e) => set({ ...b, code: e.target.value })}
          className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" />
      </label>
      <label className="flex flex-col text-xs">
        <span className="mb-1">{label} value set</span>
        <input aria-label={`${label} value set`} value={b.valueSet} onChange={(e) => set({ ...b, valueSet: e.target.value })}
          className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" />
      </label>
    </div>
  );

  return (
    <div className="grid gap-4 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 lg:grid-cols-2">
      <div className="grid gap-3">
        <label className="flex flex-col text-xs font-medium">
          <span className="mb-1">Rule shape</span>
          <select aria-label="Rule shape" value={shape} onChange={(e) => setShape(e.target.value as Shape)}
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700">
            <option value="series-completion">Series completion (dose count)</option>
            <option value="windowed-recency">Windowed recency (days since)</option>
          </select>
        </label>

        {shape === "series-completion" ? (
          <>
            <label className="flex flex-col text-xs">
              <span className="mb-1">Required doses</span>
              <input aria-label="Required doses" type="number" min={1} value={requiredDoses}
                onChange={(e) => setRequiredDoses(Number(e.target.value))}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={allowTiter} onChange={(e) => setAllowTiter(e.target.checked)} />
              Allow positive titer
            </label>
            {allowTiter ? (
              <div className="grid grid-cols-3 gap-2">
                <label className="flex flex-col text-xs"><span className="mb-1">Titer code</span>
                  <input aria-label="Titer code" value={titer.code} onChange={(e) => setTiter({ ...titer, code: e.target.value })}
                    className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
                <label className="flex flex-col text-xs"><span className="mb-1">Titer value set</span>
                  <input aria-label="Titer value set" value={titer.valueSet} onChange={(e) => setTiter({ ...titer, valueSet: e.target.value })}
                    className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
                <label className="flex flex-col text-xs"><span className="mb-1">Min value</span>
                  <input aria-label="Titer min value" type="number" value={titer.minValue} onChange={(e) => setTiter({ ...titer, minValue: Number(e.target.value) })}
                    className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
              </div>
            ) : null}
          </>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col text-xs"><span className="mb-1">Window (days)</span>
              <input aria-label="Window (days)" type="number" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
            <label className="flex flex-col text-xs"><span className="mb-1">Due-soon (days)</span>
              <input aria-label="Due-soon (days)" type="number" value={dueSoonDays} onChange={(e) => setDueSoonDays(Number(e.target.value))}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
            <label className="flex flex-col text-xs"><span className="mb-1">Grace (days)</span>
              <input aria-label="Grace (days)" type="number" value={gracePeriodDays} onChange={(e) => setGracePeriodDays(Number(e.target.value))}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
          </div>
        )}

        <div className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <p className="mb-2 text-xs font-semibold uppercase text-neutral-500">Bindings (code + value set)</p>
          {codeFields("Enrollment", enrollment, setEnrollment)}
          {codeFields("Waiver", waiver, setWaiver)}
          {codeFields(shape === "series-completion" ? "Vaccine" : "Event", eventCode, setEventCode)}
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={allowDeclination} onChange={(e) => setAllowDeclination(e.target.checked)} />
            Allow patient declination
          </label>
          {allowDeclination ? codeFields("Refusal", refusal, setRefusal) : null}
        </div>

        <div>
          <button type="button" onClick={save} disabled={saving || previewError != null}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {saving ? "Saving…" : "Save Rule"}
          </button>
        </div>
      </div>

      <div className="grid gap-2">
        <p className="text-xs font-semibold uppercase text-neutral-500">Generated CQL (preview)</p>
        {previewError ? (
          <p role="alert" className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">{previewError}</p>
        ) : null}
        <pre className="max-h-[28rem] overflow-auto rounded border border-neutral-200 bg-neutral-50 p-3 text-[11px] leading-snug dark:border-neutral-800 dark:bg-neutral-950">{cql || "…"}</pre>
        <p className="text-[11px] text-neutral-400">CQL stays canonical (ADR-015) — this generated CQL is saved to the version and compiled on save.</p>
      </div>
    </div>
  );
}
