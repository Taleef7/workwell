"use client";

import { useState } from "react";
import type { MeasureDetail } from "../types";

type Props = {
  measure: MeasureDetail;
};

function buildSql(measure: MeasureDetail): string {
  const {
    policyRef,
    eligibilityCriteria,
    exclusions,
    complianceWindow,
    requiredDataElements,
  } = measure;

  // Parse numeric days from compliance window string, e.g. "365 days", "820 days biannual"
  const windowMatch = complianceWindow?.match(/(\d+)/);
  const windowDays = windowMatch ? parseInt(windowMatch[1], 10) : null;
  const dueSoonDays = windowDays ? windowDays - 30 : null;

  const excl = exclusions?.[0];
  const exclSlug = excl?.criteriaText
    ? excl.criteriaText.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")
    : null;
  const exclLine = exclSlug
    ? `    WHEN ep.${exclSlug} = TRUE           THEN 'EXCLUDED'  -- ${excl!.label}`
    : `    -- (no exclusion criteria defined in Spec)`;

  const dataComment =
    (requiredDataElements ?? []).length > 0
      ? `  -- required: ${requiredDataElements.join(", ")}`
      : "";

  const enrollComment = eligibilityCriteria?.programEnrollmentText
    ? `\n  -- eligibility: ${eligibilityCriteria.programEnrollmentText}`
    : "";

  const roleClause = eligibilityCriteria?.roleFilter
    ? `  AND e.role = '${eligibilityCriteria.roleFilter}'`
    : `  -- role: unrestricted`;

  const siteClause = eligibilityCriteria?.siteFilter
    ? `  AND e.site = '${eligibilityCriteria.siteFilter}'`
    : `  -- site: all sites`;

  const overdueExpr =
    windowDays !== null
      ? `NOW() - MAX(exam.date) > INTERVAL '${windowDays} days'`
      : `/* window: ${complianceWindow ?? "see CQL"} */`;

  const dueSoonExpr =
    dueSoonDays !== null
      ? `NOW() - MAX(exam.date) > INTERVAL '${dueSoonDays} days'`
      : `/* DUE_SOON: see CQL */`;

  return `-- Illustrative analogy only — CQL is the compliance source of truth
-- Policy: ${policyRef ?? "see Spec tab"}
SELECT
  e.id,
  e.name,
  e.role,
  e.site,
  MAX(exam.date) AS last_exam_date${dataComment ? ",\n" + dataComment : ""}
  CASE
${exclLine}
    WHEN MAX(exam.date) IS NULL          THEN 'MISSING_DATA'
    WHEN ${overdueExpr}  THEN 'OVERDUE'
    WHEN ${dueSoonExpr}  THEN 'DUE_SOON'
    -- DUE_SOON threshold approximate; see CQL for exact window
    ELSE                                      'COMPLIANT'
  END AS outcome_status
FROM employees e
JOIN employee_programs ep ON ep.employee_id = e.id${enrollComment}
LEFT JOIN exams exam ON exam.employee_id = e.id
WHERE e.active = TRUE
${roleClause}
${siteClause}
GROUP BY e.id, e.name, e.role, e.site, ep.exclusion_flag`;
}

export function SqlPreviewPanel({ measure }: Props) {
  const [open, setOpen] = useState(false);
  const sql = buildSql(measure);

  return (
    <div className="rounded border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50"
        aria-expanded={open}
      >
        <span className="select-none text-[10px]">{open ? "▼" : "▶"}</span>
        SQL Analogy
        <span className="ml-1 text-[10px] font-normal text-slate-400">(derived from Spec — illustrative only)</span>
      </button>

      {open && (
        <div className="border-t border-slate-200">
          <div className="flex items-start gap-2 rounded-none border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
            <span className="mt-0.5 shrink-0 font-semibold uppercase tracking-wider text-amber-700">Illustrative only</span>
            <span>Not executed. CQL is the compliance source of truth. Column names and table structure are analogical.</span>
          </div>
          <pre
            className="overflow-x-auto rounded-b bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-200"
            data-testid="sql-preview-block"
          >
            {sql}
          </pre>
        </div>
      )}
    </div>
  );
}
