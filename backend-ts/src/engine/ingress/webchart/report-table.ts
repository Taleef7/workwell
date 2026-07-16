/**
 * Shared fixed-width per-measure outcome table for the WebChart evaluation CLIs
 * (`evaluate:webchart-devdb` over committed fixtures, `evaluate:webchart-live` over a real HTTP
 * endpoint). Extracted from `devdb-cli.ts` unchanged — the devdb report must stay byte-identical.
 */
import type { OutcomeStatus } from "../../evaluate-measure.ts";

export const BUCKETS: OutcomeStatus[] = ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"];
export const BUCKET_LABEL: Record<OutcomeStatus, string> = {
  COMPLIANT: "COMPL",
  DUE_SOON: "DUE",
  OVERDUE: "OVERDUE",
  MISSING_DATA: "MISSING",
  EXCLUDED: "EXCL",
};

export interface MeasureSummary {
  measureId: string;
  total: number;
  counts: Record<OutcomeStatus, number>;
}

export const pad = (s: string, n: number) => s.padEnd(n);
export const padL = (s: string, n: number) => s.padStart(n);

/** The header + separator + one row per measure (no caption/footer — those are per-CLI). */
export function measureTableLines(summaries: readonly MeasureSummary[]): string[] {
  const lines: string[] = [];
  lines.push(`  ${pad("measure", 22)}${BUCKETS.map((b) => padL(BUCKET_LABEL[b], 9)).join("")}${padL("total", 8)}`);
  lines.push(`  ${"-".repeat(22 + 9 * BUCKETS.length + 8)}`);
  for (const m of summaries) {
    lines.push(`  ${pad(m.measureId, 22)}${BUCKETS.map((b) => padL(String(m.counts[b]), 9)).join("")}${padL(String(m.total), 8)}`);
  }
  return lines;
}

/** A real calendar date in YYYY-MM-DD (rejects e.g. 2024-13-45, which a format regex alone would pass). */
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
