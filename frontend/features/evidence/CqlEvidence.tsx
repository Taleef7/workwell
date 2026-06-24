import React from "react";

export interface EvidenceJson {
  expressionResults?: Array<Record<string, unknown>>;
  evaluatedResource?: Record<string, unknown>;
  why_flagged?: {
    last_exam_date: string | null;
    compliance_window_days: number;
    days_overdue: number | null;
    role_eligible: boolean;
    site_eligible: boolean;
    waiver_status: string;
    outcome_status?: string;
  };
}

const INTERNAL_DEFINES = new Set([
  "Patient",
  "Initial Population",
  "Numerator",
  "Numerator Exclusion",
  "Denominator",
  "Denominator Exclusion",
  "Denominator Exception",
]);
const isInternalDefine = (define: string): boolean => INTERNAL_DEFINES.has(define.trim());

function WhyFlaggedRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="text-right font-medium text-neutral-900 dark:text-neutral-100">{value}</dd>
    </div>
  );
}

/** The non-internal CQL define results as define→result chips. Single source for case-detail + the
 *  per-employee compliance card. Display-only; never affects compliance (ADR-008). */
export function CqlExpressionResults({ results }: { results?: Array<Record<string, unknown>> }) {
  const rows = (results ?? []).filter((row) => !isInternalDefine(String(row.define ?? "")));
  if (rows.length === 0) {
    return <p className="text-xs italic text-neutral-500 dark:text-neutral-400">No evidence recorded.</p>;
  }
  return (
    <div className="space-y-2">
      {rows.map((row, index) => {
        const defineStr = String(row.define ?? "define");
        const resultStr = String(row.result ?? "");
        const isOutcomeStatus = defineStr === "Outcome Status";
        const isTrue = resultStr.toLowerCase() === "true";
        const isFalse = resultStr.toLowerCase() === "false";
        const isNull = resultStr === "null" || resultStr === "";
        const isDate = /^\d{4}-\d{2}-\d{2}/.test(resultStr);
        const isNumber = !isNaN(Number(resultStr)) && resultStr !== "" && !isDate;
        let chipClass = "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300";
        let chipLabel = resultStr || "—";
        if (isOutcomeStatus) {
          chipClass = "bg-amber-100 text-amber-900 font-semibold";
        } else if (isTrue) {
          chipClass = "bg-emerald-100 text-emerald-800";
          chipLabel = "✓ true";
        } else if (isFalse) {
          chipClass = "bg-red-100 text-red-800";
          chipLabel = "✗ false";
        } else if (isNull) {
          chipClass = "bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 italic";
          chipLabel = "not found";
        } else if (isDate) {
          chipClass = "bg-blue-100 text-blue-800";
          chipLabel = `📅 ${resultStr.slice(0, 10)}`;
        } else if (isNumber) {
          const n = Number(resultStr);
          chipClass = n > 0 ? "bg-orange-100 text-orange-800" : "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300";
        }
        return (
          <div
            key={`${defineStr}-${index}`}
            className="flex items-center justify-between gap-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 px-4 py-3"
          >
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{defineStr}</p>
            <span className={`rounded-full px-3 py-1 text-xs ${chipClass}`}>{chipLabel}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The why_flagged derived summary. Returns null when absent. */
export function CqlWhyFlagged({ whyFlagged }: { whyFlagged?: EvidenceJson["why_flagged"] }) {
  if (!whyFlagged) return null;
  return (
    <dl className="grid gap-2 text-xs text-neutral-700 dark:text-neutral-300 sm:grid-cols-2">
      <WhyFlaggedRow label="Last exam date" value={whyFlagged.last_exam_date ?? "None"} />
      <WhyFlaggedRow label="Window (days)" value={String(whyFlagged.compliance_window_days)} />
      <WhyFlaggedRow label="Days overdue" value={String(whyFlagged.days_overdue ?? 0)} />
      <WhyFlaggedRow label="Role eligible" value={whyFlagged.role_eligible ? "Yes" : "No"} />
      <WhyFlaggedRow label="Site eligible" value={whyFlagged.site_eligible ? "Yes" : "No"} />
      <WhyFlaggedRow label="Waiver status" value={whyFlagged.waiver_status} />
    </dl>
  );
}

/** Both halves together (define chips + why_flagged) — used by the per-employee compliance card. */
export function CqlEvidence({ evidence }: { evidence: EvidenceJson | null | undefined }) {
  return (
    <div className="space-y-3">
      <CqlExpressionResults results={evidence?.expressionResults} />
      <CqlWhyFlagged whyFlagged={evidence?.why_flagged} />
    </div>
  );
}
