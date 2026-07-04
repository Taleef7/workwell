"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { ApiClient } from "@/lib/api/client";
import { emitToast } from "@/lib/toast";
import type { MeasureDetail, RuleParams, RuleBindings, RuleCodeBinding, SeriesAlternative } from "../types";

type Props = {
  measure: MeasureDetail;
  measureId: string;
  api: ApiClient;
  onSaved: () => void;
  onError: (msg: string) => void;
  /** AUTHOR/ADMIN — the rule save is [AUTHOR,A] on the backend (Fable H10). */
  canAuthor: boolean;
};

type Shape = "series-completion" | "windowed-recency";

const emptyCode = (): RuleCodeBinding => ({ code: "", valueSet: "" });

// An alternative series authored as free text (codes + intervals split on commas/spaces/newlines).
type AltRow = { label: string; requiredDoses: number; codesText: string; intervalsText: string };
const emptyAlt = (): AltRow => ({ label: "", requiredDoses: 2, codesText: "", intervalsText: "" });
const parseTokens = (s: string): string[] => s.split(/[\s,]+/).map((t) => t.trim()).filter((t) => t !== "");
const parseInts = (s: string): number[] => parseTokens(s).map((t) => Number(t)).filter((n) => Number.isFinite(n));

function readableError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") return (o.message as string) || (o.error as string) || raw;
  } catch {
    /* not JSON */
  }
  return raw;
}

export function RuleBuilderTab({ measure, measureId, api, onSaved, onError, canAuthor }: Props) {
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
  // alternative series (series-completion only)
  const hydratedAlts: SeriesAlternative[] | undefined = r?.type === "series-completion" ? r.alternatives : undefined;
  const [alternativesOn, setAlternativesOn] = useState<boolean>(!!hydratedAlts?.length);
  const [alts, setAlts] = useState<AltRow[]>(
    hydratedAlts?.length
      ? hydratedAlts.map((a) => ({
          label: a.label,
          requiredDoses: a.requiredDoses,
          codesText: (rb?.eventAlternatives?.find((e) => e.label === a.label)?.codes ?? []).map((c) => c.code).join(", "),
          intervalsText: (a.minIntervalDays ?? []).join(", "),
        }))
      : [emptyAlt()]
  );

  const [cql, setCql] = useState<string>("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const eventType: "procedure" | "immunization" | "observation" = shape === "series-completion" ? "immunization" : "procedure";

  const useAlternatives = shape === "series-completion" && alternativesOn;

  // Parsed alternative series → rule.alternatives + bindings.eventAlternatives (correlated by label).
  // Each alt's codes inherit the event binding's value set. Intervals are omitted when blank (count-only).
  const altParsed = useMemo(
    () =>
      alts.map((a) => {
        const codes = parseTokens(a.codesText);
        const intervals = parseInts(a.intervalsText);
        const alternative: SeriesAlternative = {
          label: a.label.trim(),
          // Clamp the alt-path required doses to a floor of 1 so an empty/zero field can't emit a
          // Count(...) >= 0 (always-COMPLIANT) series. This clamp is intentional and applies only to
          // the alternatives path; the single-series requiredDoses path is left as the established behavior.
          requiredDoses: Math.max(1, Number(a.requiredDoses) || 1),
          ...(a.intervalsText.trim() !== "" ? { minIntervalDays: intervals } : {}),
        };
        const binding = { label: a.label.trim(), codes: codes.map((c) => ({ code: c, valueSet: eventCode.valueSet })) };
        return { alternative, binding };
      }),
    [alts, eventCode.valueSet]
  );

  const rule: RuleParams = useMemo(
    () =>
      shape === "series-completion"
        ? {
            type: "series-completion",
            requiredDoses,
            ...(allowTiter ? { allowPositiveTiter: true } : {}),
            ...(useAlternatives ? { alternatives: altParsed.map((p) => p.alternative) } : {}),
          }
        : { type: "windowed-recency", windowDays, dueSoonDays, ...(gracePeriodDays ? { gracePeriodDays } : {}) },
    [shape, requiredDoses, allowTiter, useAlternatives, altParsed, windowDays, dueSoonDays, gracePeriodDays]
  );
  const bindings: RuleBindings = useMemo(
    () => ({
      enrollment, waiver,
      event: { ...eventCode, type: eventType },
      ...(allowDeclination ? { refusal } : {}),
      ...(shape === "series-completion" && allowTiter ? { titer } : {}),
      ...(useAlternatives ? { eventAlternatives: altParsed.map((p) => p.binding) } : {}),
    }),
    [enrollment, waiver, eventCode, eventType, allowDeclination, refusal, shape, allowTiter, titer, useAlternatives, altParsed]
  );

  // Each binding needs BOTH a code and a value set before a preview/save: the generated CQL matches
  // a coding's system against the value-set URI, so an empty value set compiles but never matches
  // real codings (incorrect outcomes). Gate on code + valueSet for every active binding.
  const bindingsComplete = useMemo(() => {
    const full = (b: RuleCodeBinding) => b.code.trim() !== "" && b.valueSet.trim() !== "";
    if (!full(enrollment) || !full(waiver)) return false;
    if (allowDeclination && !full(refusal)) return false;
    if (shape === "series-completion" && allowTiter && !(titer.code.trim() !== "" && titer.valueSet.trim() !== "")) return false;
    if (useAlternatives) {
      // The alts inherit the event value set, so it must be set; the single event code is not the driver.
      if (eventCode.valueSet.trim() === "") return false;
      for (const a of alts) {
        const codes = parseTokens(a.codesText);
        if (a.label.trim() === "" || codes.length === 0) return false;
        if (a.intervalsText.trim() !== "" && parseInts(a.intervalsText).length !== a.requiredDoses - 1) return false;
      }
      return true;
    }
    if (!full(eventCode)) return false;
    return true;
  }, [enrollment, waiver, eventCode, allowDeclination, refusal, shape, allowTiter, titer, useAlternatives, alts]);

  // Debounced live preview.
  useEffect(() => {
    let cancelled = false;
    // Skip the fetch until binding codes are set; clear stale preview state so the
    // pane shows the placeholder (deferred so it never runs synchronously in the effect body).
    if (!bindingsComplete) {
      const clear = setTimeout(() => {
        if (!cancelled) {
          setPreviewError(null);
          setCql("");
        }
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(clear);
      };
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.post<{ rule: RuleParams; bindings: RuleBindings }, { cql: string }>(
          `/api/measures/${measureId}/rule/preview`, { rule, bindings }
        );
        if (!cancelled) {
          setCql(res.cql);
          setPreviewError(null);
        }
      } catch (e) {
        if (!cancelled) setPreviewError(readableError(e));
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [api, measureId, rule, bindings, bindingsComplete]);

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
      onError(readableError(e));
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
            {!useAlternatives ? (
              <label className="flex flex-col text-xs">
                <span className="mb-1">Required doses</span>
                <input aria-label="Required doses" type="number" min={1} value={requiredDoses}
                  onChange={(e) => setRequiredDoses(Number(e.target.value))}
                  className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" />
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" aria-label="Alternative series (multi-brand)" checked={alternativesOn}
                onChange={(e) => setAlternativesOn(e.target.checked)} />
              Alternative series (multi-brand) — OR of distinct dose series
            </label>
            {useAlternatives ? (
              <div className="grid gap-3 rounded border border-neutral-200 p-2 dark:border-neutral-800">
                {alts.map((a, i) => (
                  <div key={i} className="grid gap-2 border-b border-neutral-100 pb-2 last:border-b-0 last:pb-0 dark:border-neutral-800">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex flex-col text-xs"><span className="mb-1">{`Alternative ${i + 1} label`}</span>
                        <input aria-label={`Alternative ${i + 1} label`} value={a.label}
                          onChange={(e) => setAlts((prev) => prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                          className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
                      <label className="flex flex-col text-xs"><span className="mb-1">{`Alternative ${i + 1} required doses`}</span>
                        <input aria-label={`Alternative ${i + 1} required doses`} type="number" min={1} value={a.requiredDoses}
                          onChange={(e) => setAlts((prev) => prev.map((x, j) => (j === i ? { ...x, requiredDoses: Number(e.target.value) } : x)))}
                          className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
                    </div>
                    <label className="flex flex-col text-xs"><span className="mb-1">{`Alternative ${i + 1} CVX codes`}</span>
                      <input aria-label={`Alternative ${i + 1} cvx codes`} value={a.codesText} placeholder="189 (comma/space separated)"
                        onChange={(e) => setAlts((prev) => prev.map((x, j) => (j === i ? { ...x, codesText: e.target.value } : x)))}
                        className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
                    <label className="flex flex-col text-xs"><span className="mb-1">{`Alternative ${i + 1} min intervals (days)`}</span>
                      <input aria-label={`Alternative ${i + 1} min intervals (days)`} value={a.intervalsText} placeholder="optional, e.g. 28, 56"
                        onChange={(e) => setAlts((prev) => prev.map((x, j) => (j === i ? { ...x, intervalsText: e.target.value } : x)))}
                        className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" /></label>
                    {alts.length > 1 ? (
                      <button type="button" aria-label={`Remove alternative ${i + 1}`}
                        onClick={() => setAlts((prev) => prev.filter((_, j) => j !== i))}
                        className="justify-self-start rounded border border-neutral-300 px-2 py-1.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
                <button type="button" onClick={() => setAlts((prev) => [...prev, emptyAlt()])}
                  className="justify-self-start rounded border border-neutral-300 px-2 py-1.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
                  Add alternative
                </button>
                <p className="text-[11px] text-neutral-600 dark:text-neutral-400">Each alternative&apos;s codes inherit the vaccine value set below.</p>
              </div>
            ) : null}
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
          {useAlternatives ? (
            // With alternatives on, the single event code is not the series driver — only its value set
            // is reused by each alternative's codes, so collect just the value set here.
            <label className="flex flex-col text-xs">
              <span className="mb-1">Vaccine value set (shared by alternatives)</span>
              <input aria-label="Vaccine value set" value={eventCode.valueSet}
                onChange={(e) => setEventCode({ ...eventCode, valueSet: e.target.value })}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" />
            </label>
          ) : (
            codeFields(shape === "series-completion" ? "Vaccine" : "Event", eventCode, setEventCode)
          )}
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={allowDeclination} onChange={(e) => setAllowDeclination(e.target.checked)} />
            Allow patient declination
          </label>
          {allowDeclination ? codeFields("Refusal", refusal, setRefusal) : null}
        </div>

        <div>
          <button type="button" onClick={save} disabled={saving || previewError != null || !bindingsComplete || !canAuthor}
            title={canAuthor ? undefined : "Authoring requires the AUTHOR or ADMIN role"}
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
        <p className="text-[11px] text-neutral-600 dark:text-neutral-400">CQL stays canonical (ADR-015) — this generated CQL is saved to the version and compiled on save.</p>
      </div>
    </div>
  );
}
