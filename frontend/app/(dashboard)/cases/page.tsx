"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge, Button, Input, Select } from "@mieweb/ui";
import { emitToast } from "@/lib/toast";
import {
  CASE_STATUS_LABELS,
  OUTCOME_LABELS,
  PRIORITY_LABELS,
  caseStatusClass,
  labelFor,
  normalizeEnumValue,
  outcomeStatusClass
} from "@/lib/status";
import { SUBJECT } from "@/lib/terminology";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useApi } from "@/lib/api/hooks";
import { SkeletonRow } from "@/components/skeleton-loader";
import { useAuth } from "@/components/auth-provider";
import { canManageCases } from "@/lib/rbac";
import { SlaChip } from "@/components/SlaChip";
import { ChevronRight } from "lucide-react";
import { useMeasureIdentities } from "@/lib/measure-identity";
import { formatEvaluationPeriod, fmtCount } from "@/lib/format";
import { providerFilterLabel, usePanelProviders } from "@/features/panel/use-panel-providers";
import { UNASSIGN_VALUE, useAssignableUsers } from "@/features/panel/use-assignable-users";

type CaseSummary = {
  caseId: string;
  employeeId: string;
  employeeName: string;
  site: string;
  measureId: string;
  measureVersionId: string;
  measureName: string;
  measureVersion: string;
  evaluationPeriod: string;
  status: string;
  priority: string;
  assignee: string | null;
  currentOutcomeStatus: string;
  lastRunId: string;
  exclusionReason: string | null;
  waiverExpiresAt: string | null;
  waiverExpired: boolean;
  updatedAt: string;
  slaRemainingDays?: number | null;
  slaBreached?: boolean;
  /**
   * Who closed it (#569). `closure` is the derived kind — NONE for an active case, STAFF for every
   * closure a person made (manual or rerun-verified), SYSTEM for the run's.
   */
  closedAt?: string | null;
  closedReason?: string | null;
  closedBy?: string | null;
  closure?: "NONE" | "STAFF" | "SYSTEM";
  /**
   * What CQL says TODAY, present on STAFF-closed rows only. `currentOutcomeStatus` is frozen at the
   * moment of closure for those rows (the nightly run never touches a human closure again), so it is
   * the one field that can be months stale — these are what the row renders instead.
   */
  liveState?: "GAP" | "CLEAR" | "UNKNOWN";
  liveOutcomeStatus?: string | null;
  /**
   * The cell's DISPLAY state, which is what this page renders. The canonical bucket alone cannot word
   * a row: a patient the measure no longer describes is canonical MISSING_DATA and display
   * OUT_OF_POPULATION, so a page reading only the bucket would show "Missing Data" beside a CLEAR
   * state rendered as "verified compliant" — two false statements about one patient.
   */
  liveDisplayStatus?: string | null;
  liveOutcomeRunId?: string | null;
};

type MeasureOption = {
  id: string;
  name: string;
  status: string;
};

type CaseStatusFilter = "open" | "closed" | "staff_closed" | "excluded" | "all";

/** The three counts the staff-closed tab's header shows, read from the response headers (#569). */
type StaffClosedCounts = { gap: number; verified: number; unknown: number };

const STATUS_TAB_LABELS: Record<CaseStatusFilter, string> = {
  open: "Open",
  closed: "Closed",
  // Deliberately not "Resolved": resolving is what the run does when CQL agrees, and closing is what
  // a person does. The distinction is the point of the tab.
  staff_closed: "Closed by staff",
  all: "All",
  excluded: "Excluded",
};

/**
 * How a staff closure reads on a row — the words follow the LIVE outcome, never the closure alone.
 *
 * The rule the practice's quality lead stated: a measure is satisfied by a RESULT, never by an
 * action. So a person's closure that CQL does not corroborate says the patient is still counted, and
 * one it does corroborate says verified. Getting this wrong in either direction is the whole defect
 * #569 exists to fix, so the wording is computed in one place.
 */
function staffClosureLine(item: CaseSummary): string | null {
  if (item.closure !== "STAFF" || !item.closedBy) return null;
  const when = item.closedAt ? new Date(item.closedAt).toLocaleDateString() : null;
  const who = `closed by ${item.closedBy}${when ? ` on ${when}` : ""}`;
  if (item.liveState === "CLEAR") {
    // CLEAR covers three different facts and only two of them are a verification. The word is chosen
    // from the DISPLAY state, never from the canonical bucket: a patient who fell out of the measure's
    // population is canonical MISSING_DATA, and calling that "verified compliant" would credit a
    // person with a result nobody produced — the exact over-claim this change exists to remove.
    const display = (item.liveDisplayStatus ?? item.liveOutcomeStatus ?? "").toUpperCase();
    if (display === "OUT_OF_POPULATION") return `${who} — outside this measure's population`;
    if (display === "EXCLUDED") return `verified excluded by ${item.closedBy}${when ? ` on ${when}` : ""}`;
    if (display === "COMPLIANT") return `verified compliant by ${item.closedBy}${when ? ` on ${when}` : ""}`;
    // Anything else CQL no longer counts: say that, rather than guessing at "compliant".
    return `${who} — no longer counted by CQL`;
  }
  if (item.liveState === "UNKNOWN") return `${who} — current CQL status unavailable`;
  if (item.liveState === "GAP") return `${who} — still counted by CQL`;
  // No live status on the row at all — an older backend, or a row the server chose not to resolve.
  // Say who closed it and stop, rather than claiming anything about a status nobody resolved.
  return who;
}

/**
 * The outcome status a row should SHOW (#569).
 *
 * For a staff-closed row that is the winning run's answer, not the case column: the column froze the
 * moment a person closed the case and the run has written several answers since. For every other row
 * the case column IS live, so it is used unchanged.
 */
function displayOutcomeOf(item: CaseSummary): string {
  if (item.closure === "STAFF" && item.liveState && item.liveState !== "UNKNOWN") {
    // The DISPLAY state first: it is the one that can say OUT_OF_POPULATION, which the canonical
    // bucket (MISSING_DATA) cannot, and which the chip beside the closure line has to agree with.
    return item.liveDisplayStatus ?? item.liveOutcomeStatus ?? item.currentOutcomeStatus;
  }
  return item.currentOutcomeStatus;
}

/** The closure line under a row, when there is one to show. */
function StaffClosureNote({ item, className = "" }: { item: CaseSummary; className?: string }) {
  const line = staffClosureLine(item);
  if (!line) return null;
  return <p className={`text-[11px] leading-tight text-neutral-500 dark:text-neutral-400 ${className}`}>{line}</p>;
}

/** "Closed by staff" / "Auto-resolved" — which KIND of closure a row on the Closed or All tab is. */
function ClosureKindChip({ item }: { item: CaseSummary }) {
  if (item.closure !== "STAFF" && item.closure !== "SYSTEM") return null;
  const staff = item.closure === "STAFF";
  return (
    <span
      className="inline-flex items-center rounded-full border border-neutral-200 bg-transparent px-2 py-0.5 text-[10px] font-medium text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
      title={staff ? "A person closed this case" : "The nightly run closed this case"}
    >
      {staff ? "Closed by staff" : "Auto-resolved"}
    </span>
  );
}

/** The bulk-assign contract (`POST /api/cases/bulk-assign`). */
type BulkAssignRequest = { assignee: string | null; caseIds: string[] };
/** What actually MOVED, which is not the same as what was asked for. */
type BulkAssignResult = { assigned: number; unchanged: number; missing: string[]; closed: string[] };

const PRIORITY_BADGE_VARIANT: Record<string, "danger" | "warning" | "secondary"> = {
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "secondary"
};

function normalizeCaseStatusFilter(value: string | null): CaseStatusFilter {
  switch (value?.toLowerCase()) {
    case "closed":
      return "closed";
    case "staff_closed":
      return "staff_closed";
    case "excluded":
      return "excluded";
    case "all":
      return "all";
    case "open":
    default:
      return "open";
  }
}

/**
 * The five buckets a CASE can carry, enumerated rather than taken from `OUTCOME_LABELS`. That label
 * table is shared with the programs card, and when `OUT_OF_POPULATION` was added to it for the card's
 * new chip this filter silently started accepting `?outcome=OUT_OF_POPULATION` — which matches no
 * case (an out-of-population subject opens none, ADR-078), leaving the worklist empty under a select
 * showing no selection. A filter's vocabulary is its own.
 */
const OUTCOME_FILTER_VALUES = new Set(["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"]);

function normalizeOutcomeFilter(raw: string | null): string {
  return raw && OUTCOME_FILTER_VALUES.has(raw) ? raw : "";
}

export default function CasesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlStatus = searchParams.get("status");
  const urlMeasure = searchParams.get("measureId") ?? "";
  const urlOutcome = normalizeOutcomeFilter(searchParams.get("outcome"));
  // The PCP panel filter lives in the URL like measure/outcome, so a filtered work list is a link a
  // staff member can keep or send. The roster's provider filter is the same query key on the same
  // shared predicate (`subject-filters.ts`), so the two surfaces agree on what a panel is.
  const urlProviderId = searchParams.get("providerId")?.trim() ?? "";
  const urlSearch = searchParams.get("search") ?? "";
  const view = searchParams.get("view") ?? "all";
  const { user } = useAuth();
  const canManage = canManageCases(user?.role);
  const isPatientTerm = SUBJECT.singular === "patient";
  const { labelFor: measureLabelFor } = useMeasureIdentities();
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [measures, setMeasures] = useState<MeasureOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusFilter = normalizeCaseStatusFilter(urlStatus);
  // Derived from the URL (like statusFilter) rather than useState-initialized, so browser
  // back/forward between two filtered /cases URLs re-renders with the right filter.
  const measureFilter = urlMeasure;
  const providerFilter = urlProviderId;
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [siteFilter, setSiteFilter] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState<string>(urlSearch);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [bulkAssignee, setBulkAssignee] = useState("");
  const [bulkActing, setBulkActing] = useState<"assign" | "escalate" | "export" | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [staffClosedCounts, setStaffClosedCounts] = useState<StaffClosedCounts | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const { siteId, from, to } = useGlobalFilters();
  const api = useApi();
  const [pageSize, setPageSize] = useState(25);
  const outcomeFilter = urlOutcome;
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const { options: providerOptions } = usePanelProviders();
  const { options: assignableOptions, canonicalFor } = useAssignableUsers(canManage);

  // Track the most recent search value we ourselves wrote to the URL so we can
  // distinguish state-driven URL writes from external URL changes (browser
  // back/forward, deep links, other controls). Without this guard, an external
  // URL change would see a mismatch with stale local state and get clobbered
  // back to the old value after the debounce window.
  const lastWrittenSearchRef = useRef<string>(urlSearch);

  // URL → state: pull external URL changes into the input state.
  useEffect(() => {
    if (urlSearch === lastWrittenSearchRef.current) {
      return;
    }
    lastWrittenSearchRef.current = urlSearch;
    setSearchTerm(urlSearch);
  }, [urlSearch]);

  // state → URL: debounce-write user input to the URL.
  useEffect(() => {
    const trimmed = searchTerm.trim();
    if (trimmed === urlSearch.trim()) {
      return;
    }
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (trimmed) {
        params.set("search", trimmed);
      } else {
        params.delete("search");
      }
      const query = params.toString();
      lastWrittenSearchRef.current = trimmed;
      router.replace(query ? `${pathname}?${query}` : pathname);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchTerm, urlSearch, searchParams, router, pathname]);

  const loadMeasures = useCallback(async () => {
    try {
      const data = await api.get<MeasureOption[]>("/api/measures");
      setMeasures(data.filter((item) => item.status === "Active"));
    } catch {
      setMeasures([]);
    }
  }, [api, setMeasures]);

  /**
   * The nine filters this screen is showing, as query params — built ONCE, for the list, the
   * "load more" page AND the export.
   *
   * The export button used to spell its own URL with three of them (status, measureId, providerId),
   * so a CSV taken from a list narrowed by site, priority, assignee, a date window, an outcome or a
   * search was a WIDER file than the screen it came from, under a heading that said otherwise, with
   * nothing to notice. Three copies of one list of filters is why: two of them drifted the moment a
   * filter was added to the other. Paging is the caller's (`limit`/`offset` are set per call), because
   * an export is not paged.
   */
  const caseFilterParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set("status", statusFilter);
    if (measureFilter) params.set("measureId", measureFilter);
    if (providerFilter) params.set("providerId", providerFilter);
    if (priorityFilter) params.set("priority", priorityFilter);
    const effectiveAssignee = view === "mine" ? (user?.email ?? "") : assigneeFilter;
    if (effectiveAssignee) params.set("assignee", effectiveAssignee);
    if (siteFilter) params.set("site", siteFilter);
    else if (siteId) params.set("site", siteId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (outcomeFilter) params.set("outcome", outcomeFilter);
    if (urlSearch.trim()) params.set("search", urlSearch.trim());
    return params;
  }, [statusFilter, measureFilter, providerFilter, priorityFilter, view, user, assigneeFilter, siteFilter, siteId, from, to, outcomeFilter, urlSearch]);

  // Stale-fetch guard (Fable M20): a slow response for one filter set must not overwrite a newer one's
  // rows (or clobber the selection). Only the latest loadCases applies its result.
  const casesReqIdRef = useRef(0);
  const loadCases = useCallback(async () => {
    const reqId = ++casesReqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = caseFilterParams();
      params.set("limit", String(pageSize));
      params.set("offset", "0");
      // #150 M10: X-Total-Count carries the full filtered match count, so paging is driven by the real
      // total (not the brittle "page was full" heuristic, which mis-signals when total is an exact multiple).
      const { data, headers } = await api.getWithHeaders<CaseSummary[]>(`/api/cases?${params.toString()}`);
      if (reqId !== casesReqIdRef.current) return;
      const matchTotal = Number(headers.get("X-Total-Count") ?? data.length);
      // The staff-closed tab's three counts describe the WHOLE filtered list, not the page, so they
      // come from headers rather than from a tally of the rows on screen — the same reason the total
      // does (#150 M10). Absent on every other tab, and then the header line is not rendered.
      setStaffClosedCounts(
        statusFilter === "staff_closed"
          ? {
              gap: Number(headers.get("X-Staff-Closed-Gap") ?? 0) || 0,
              verified: Number(headers.get("X-Staff-Closed-Verified") ?? 0) || 0,
              unknown: Number(headers.get("X-Staff-Closed-Unknown") ?? 0) || 0,
            }
          : null,
      );
      setCases(data);
      setTotal(Number.isFinite(matchTotal) ? matchTotal : data.length);
      setHasMore(data.length < (Number.isFinite(matchTotal) ? matchTotal : data.length));
      setSelectedCaseIds((existing) => existing.filter((id) => data.some((item) => item.caseId === id)));
    } catch (err) {
      if (reqId !== casesReqIdRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (reqId === casesReqIdRef.current) setLoading(false);
    }
  }, [api, caseFilterParams, pageSize, statusFilter, setLoading, setError, setCases, setSelectedCaseIds]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadMeasures();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadMeasures]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadCases();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadCases]);

  const filteredCases = cases;
  /**
   * Whether rows on THIS list can be bulk-actioned (#569).
   *
   * Not on a closed list. Assigning a closed case answers 0 — annoying but harmless — while
   * ESCALATING one writes `status: "OPEN"` (`case-actions.ts`), silently reopening a case somebody
   * deliberately closed with a reason. The roster gates the same affordance per cell; these lists gate
   * it per view, because every row on them is closed.
   */
  const canBulkAct = canManage && statusFilter !== "staff_closed" && statusFilter !== "closed" && statusFilter !== "excluded";

  const allFilteredSelected = filteredCases.length > 0 && filteredCases.every((item) => selectedCaseIds.includes(item.caseId));

  const measureOptions = useMemo(
    () => [{ value: "", label: "All Active Measures" }, ...measures.map((m) => ({ value: m.id, label: m.name }))],
    [measures]
  );
  const priorityOptions = useMemo(
    () => [
      { value: "", label: "All Priorities" },
      { value: "HIGH", label: labelFor(PRIORITY_LABELS, "HIGH") },
      { value: "MEDIUM", label: labelFor(PRIORITY_LABELS, "MEDIUM") },
      { value: "LOW", label: labelFor(PRIORITY_LABELS, "LOW") }
    ],
    []
  );
  const assigneeOptions = useMemo(
    () => [
      { value: "", label: "All Assignees" },
      { value: "unassigned", label: "Unassigned" },
      ...[...new Set(cases.map((item) => item.assignee).filter((item): item is string => Boolean(item)))].map((a) => ({
        value: a,
        label: a
      }))
    ],
    [cases]
  );
  const siteOptions = useMemo(
    () => [
      { value: "", label: "All Sites" },
      ...[...new Set(cases.map((item) => item.site).filter(Boolean))].map((s) => ({ value: s, label: s }))
    ],
    [cases]
  );
  // Outcome bucket ("why flagged") — distinct from case status. Drives the new ?outcome= filter.
  const outcomeOptions = useMemo(
    () => [
      { value: "", label: "All Outcomes" },
      { value: "OVERDUE", label: labelFor(OUTCOME_LABELS, "OVERDUE") },
      { value: "DUE_SOON", label: labelFor(OUTCOME_LABELS, "DUE_SOON") },
      { value: "MISSING_DATA", label: labelFor(OUTCOME_LABELS, "MISSING_DATA") },
      { value: "COMPLIANT", label: labelFor(OUTCOME_LABELS, "COMPLIANT") },
      { value: "EXCLUDED", label: labelFor(OUTCOME_LABELS, "EXCLUDED") }
    ],
    []
  );
  const pageSizeOptions = useMemo(
    () => [25, 50, 100, 200, 500].map((n) => ({ value: String(n), label: `${n} / page` })),
    []
  );

  const setStatusAndUrl = useCallback((nextStatus: CaseStatusFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextStatus === "open") {
      params.delete("status");
    } else {
      params.set("status", nextStatus);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams]);

  const setMeasureAndUrl = useCallback((nextMeasure: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextMeasure) {
      params.set("measureId", nextMeasure);
    } else {
      params.delete("measureId");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams]);

  const setProviderAndUrl = useCallback((nextProvider: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextProvider) {
      params.set("providerId", nextProvider);
    } else {
      params.delete("providerId");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams]);

  const setOutcomeAndUrl = useCallback((nextOutcome: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextOutcome) {
      params.set("outcome", nextOutcome);
    } else {
      params.delete("outcome");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams]);

  function toggleCase(caseId: string) {
    setSelectedCaseIds((existing) =>
      existing.includes(caseId) ? existing.filter((id) => id !== caseId) : [...existing, caseId]
    );
  }

  function toggleAllFiltered() {
    if (allFilteredSelected) {
      setSelectedCaseIds((existing) => existing.filter((id) => !filteredCases.some((item) => item.caseId === id)));
      return;
    }
    const ids = new Set(selectedCaseIds);
    filteredCases.forEach((item) => ids.add(item.caseId));
    setSelectedCaseIds(Array.from(ids));
  }

  async function loadMoreCases() {
    setLoadingMore(true);
    try {
      const params = caseFilterParams();
      params.set("limit", String(pageSize));
      params.set("offset", String(cases.length));
      const { data: next, headers } = await api.getWithHeaders<CaseSummary[]>(`/api/cases?${params.toString()}`);
      const matchTotal = Number(headers.get("X-Total-Count") ?? 0);
      setCases((prev) => {
        const merged = [...prev, ...next];
        setHasMore(merged.length < (Number.isFinite(matchTotal) && matchTotal > 0 ? matchTotal : merged.length));
        return merged;
      });
      if (Number.isFinite(matchTotal) && matchTotal > 0) setTotal(matchTotal);
    } catch {
      // ignore
    } finally {
      setLoadingMore(false);
    }
  }

  async function exportCsv(urlPath: string, filename: string) {
    try {
      const blob = await api.downloadBlob(urlPath);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    }
  }

  async function bulkAssign() {
    if (selectedCaseIds.length === 0 || bulkAssignee === "") return;
    // The control offers only accounts the server accepts plus an explicit "Unassign", so a typed
    // address that assigns nobody is no longer reachable. The guard stays because the value also
    // arrives from state that a future caller could set.
    const unassign = bulkAssignee === UNASSIGN_VALUE;
    if (!unassign && !canonicalFor(bulkAssignee)) {
      setError(`${bulkAssignee} is not an account cases can be assigned to.`);
      return;
    }
    setBulkActing("assign");
    setError(null);
    try {
      // ONE request, not one per case. The loop this replaces issued N sequential round trips and had
      // no transaction around them, so a failure at case 40 of 200 left 39 assigned, 161 untouched and
      // a toast that said nothing about either. The endpoint reports exactly what moved.
      const result = await api.post<BulkAssignRequest, BulkAssignResult>(
        "/api/cases/bulk-assign",
        { assignee: unassign ? null : bulkAssignee, caseIds: selectedCaseIds },
      );
      await loadCases();
      const moved = result?.assigned ?? 0;
      const noun = `case${moved === 1 ? "" : "s"}`;
      // The toast reports what HAPPENED rather than what was asked for. "200 assigned" over 40 moved
      // rows is the count-not-describing-the-list defect in its smallest form.
      const skipped = (result?.closed?.length ?? 0) + (result?.missing?.length ?? 0);
      const tail = skipped > 0 ? ` (${skipped} skipped — already closed or no longer present)` : "";
      emitToast(
        moved === 0
          ? `No cases changed${tail || " — they were already assigned that way"}`
          : unassign
            ? `${moved} ${noun} unassigned${tail}`
            : `${moved} ${noun} assigned to ${bulkAssignee}${tail}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBulkActing(null);
    }
  }

  async function bulkEscalate() {
    if (selectedCaseIds.length === 0) return;
    setBulkActing("escalate");
    setError(null);
    try {
      for (const caseId of selectedCaseIds) {
        await api.post(`/api/cases/${caseId}/escalate`);
      }
      await loadCases();
      emitToast("Selected cases escalated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBulkActing(null);
    }
  }

  async function bulkExportSelected() {
    if (selectedCaseIds.length === 0) {
      return;
    }
    setBulkActing("export");
    try {
      const params = new URLSearchParams();
      params.set("format", "csv");
      params.set("caseIds", selectedCaseIds.join(","));
      await exportCsv(`/api/exports/cases?${params.toString()}`, "cases-selected.csv");
      emitToast("Selected cases exported");
    } finally {
      setBulkActing(null);
    }
  }

  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-neutral-800 bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-950 p-8 text-white shadow-lg">
        <p className="text-sm uppercase tracking-[0.3em] text-neutral-300">Caseflow</p>
        <h2 className="mt-2 text-3xl font-semibold text-white">Why Flagged cases</h2>
        <p className="mt-3 max-w-2xl text-neutral-300">
          Your daily worklist of {SUBJECT.plural} flagged by the latest measure runs. Each card links to the structured
          evidence that explains why the case is open, including {isPatientTerm ? "exclusion" : "waiver"} context when an exclusion applies.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Open and recent cases</h3>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Filter, search, and bulk-act on flagged cases.</p>
        </div>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {total > cases.length
            ? `${cases.length} of ${total} cases`
            : `${cases.length} case${cases.length !== 1 ? "s" : ""} loaded`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const params = caseFilterParams();
              params.set("format", "csv");
              void exportCsv(`/api/exports/cases?${params.toString()}`, "cases.csv");
            }}
          >
            Export cases CSV
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void exportCsv("/api/audit-events/export?format=csv", "audit-events.csv")}
          >
            Export audit CSV
          </Button>
        </div>
      </div>

      <div className="mb-4 flex gap-0 border-b border-neutral-200 dark:border-neutral-800">
        {(["all", "mine"] as const).map((tab) => {
          const active = tab === "mine" ? view === "mine" : view !== "mine";
          return (
            <button
              key={tab}
              type="button"
              onClick={() => {
                const params = new URLSearchParams(searchParams.toString());
                params.set("view", tab);
                router.push(`/cases?${params.toString()}`);
              }}
              className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-primary-600 text-primary-700 dark:text-primary-400"
                  : "border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
              }`}
            >
              {tab === "mine" ? "My Cases" : "All Cases"}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
          <span>Status</span>
          {(["open", "closed", "staff_closed", "all", "excluded"] as const).map((status) => (
            <Button
              key={status}
              type="button"
              size="sm"
              variant={statusFilter === status ? "primary" : "outline"}
              className="rounded-full"
              onClick={() => setStatusAndUrl(status)}
            >
              {STATUS_TAB_LABELS[status]}
            </Button>
          ))}
        </div>
        <Select
          label="Measure"
          size="sm"
          className="w-48"
          value={measureFilter}
          onValueChange={setMeasureAndUrl}
          options={measureOptions}
        />
        <Select
          label={providerFilterLabel()}
          size="sm"
          className="w-52"
          value={providerFilter}
          onValueChange={setProviderAndUrl}
          options={providerOptions}
        />
        <Select
          label="Priority"
          size="sm"
          className="w-40"
          value={priorityFilter}
          onValueChange={setPriorityFilter}
          options={priorityOptions}
        />
        <Select
          label="Assignee"
          size="sm"
          className="w-44"
          value={assigneeFilter}
          onValueChange={setAssigneeFilter}
          options={assigneeOptions}
        />
        <Select
          label="Site"
          size="sm"
          className="w-40"
          value={siteFilter}
          onValueChange={setSiteFilter}
          options={siteOptions}
        />
        <Select
          label="Outcome"
          size="sm"
          className="w-44"
          value={outcomeFilter}
          onValueChange={setOutcomeAndUrl}
          options={outcomeOptions}
        />
        <Input
          label="Search"
          size="sm"
          className="w-56"
          placeholder={`${SUBJECT.Singular} name or ID`}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <Select
          label="Per page"
          size="sm"
          className="w-32"
          value={String(pageSize)}
          onValueChange={(v) => setPageSize(Number(v))}
          options={pageSizeOptions}
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">View</span>
          <div className="inline-flex overflow-hidden rounded-lg border border-neutral-300 dark:border-neutral-700" role="group" aria-label="Result view">
            {(["cards", "table"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={viewMode === mode}
                onClick={() => setViewMode(mode)}
                className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  viewMode === mode
                    ? "bg-primary-600 text-white"
                    : "bg-white text-neutral-600 hover:bg-neutral-50 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/*
        The staff-closed tab's header (#569). The three numbers describe the whole filtered list and
        are the point of the tab: a coordinator needs to know how many of the cases their team closed
        are still counted against them. "Not evaluated" is shown rather than folded into either of the
        others — a patient no run has scored has not been verified.
      */}
      {staffClosedCounts && !loading && !error ? (
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          <strong>{fmtCount(staffClosedCounts.gap)}</strong> still counted by CQL
          <span className="text-neutral-400 dark:text-neutral-500"> · </span>
          <strong>{fmtCount(staffClosedCounts.verified)}</strong> verified
          <span className="text-neutral-400 dark:text-neutral-500"> · </span>
          <strong>{fmtCount(staffClosedCounts.unknown)}</strong> not evaluated
        </p>
      ) : null}

      {canBulkAct && selectedCaseIds.length > 0 ? (
        <div className="rounded-xl border border-primary-200 bg-primary-50 p-3 dark:border-primary-800 dark:bg-primary-900/20">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-semibold text-primary-900 dark:text-primary-200">{selectedCaseIds.length} selected</span>
            <Select
              label="Assignee for selected"
              hideLabel
              size="sm"
              className="w-64"
              value={bulkAssignee}
              onValueChange={setBulkAssignee}
              options={assignableOptions}
              disabled={bulkActing !== null}
            />
            <Button
              size="sm"
              variant="primary"
              disabled={bulkActing !== null || bulkAssignee === ""}
              onClick={() => void bulkAssign()}
            >
              {bulkActing === "assign" ? "Assigning..." : "Assign selected"}
            </Button>
            <Button size="sm" variant="danger" disabled={bulkActing !== null} onClick={() => void bulkEscalate()}>
              {bulkActing === "escalate" ? "Escalating..." : "Escalate selected"}
            </Button>
            <Button size="sm" variant="outline" disabled={bulkActing !== null} onClick={() => void bulkExportSelected()}>
              {bulkActing === "export" ? "Exporting..." : "Export selected"}
            </Button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table className="min-w-full text-sm">
            <tbody>{Array.from({ length: 10 }, (_, i) => <SkeletonRow key={i} cols={8} />)}</tbody>
          </table>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">Error: {error}</p> : null}

      {!loading && !error && filteredCases.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
          {urlSearch.trim()
            ? `No results match your search "${urlSearch.trim()}".`
            : statusFilter === "excluded"
              ? "No excluded cases yet."
              : statusFilter === "closed"
                ? "No closed cases yet."
                : statusFilter === "all"
                  ? "No cases found for the current filters."
                  : "No open cases. Run a measure to generate cases."}
        </div>
      ) : null}

      {canBulkAct && filteredCases.length > 0 ? (
        <label className="hidden items-center gap-2 text-sm text-neutral-600 md:flex dark:text-neutral-400">
          <input type="checkbox" checked={allFilteredSelected} onChange={toggleAllFiltered} />
          <span>Select all in current results</span>
        </label>
      ) : null}

      <div className="space-y-2 md:hidden">
        {filteredCases.map((item) => {
          const outcomeLabel = labelFor(OUTCOME_LABELS, displayOutcomeOf(item));
          return (
            <Link
              key={item.caseId}
              href={`/cases/${item.caseId}`}
              className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{item.employeeName}</p>
                <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{measureLabelFor(item.measureId, item.measureName)}</p>
                <StaffClosureNote item={item} className="truncate" />
              </div>
              <div className="ml-3 flex items-center gap-2">
                <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${outcomeStatusClass(displayOutcomeOf(item))}`}>
                  {outcomeLabel}
                </span>
                <ChevronRight className="h-4 w-4 text-neutral-400" />
              </div>
            </Link>
          );
        })}
      </div>

      {viewMode === "table" ? (
        <CasesTable items={filteredCases} selectedCaseIds={selectedCaseIds} onToggle={toggleCase} canManage={canBulkAct} measureLabelFor={measureLabelFor} />
      ) : (
      <div className="hidden gap-4 md:grid md:grid-cols-2 xl:grid-cols-3">
        {filteredCases.map((item) => {
          const caseStatus = normalizeEnumValue(item.status);
          const caseStatusLabel = labelFor(CASE_STATUS_LABELS, item.status);
          const priorityLabel = labelFor(PRIORITY_LABELS, item.priority);
          return (
            <div key={item.caseId} className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
              <div className="flex items-start justify-between gap-3">
                {canBulkAct ? (
                  <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.employeeName}`}
                      checked={selectedCaseIds.includes(item.caseId)}
                      onChange={() => toggleCase(item.caseId)}
                    />
                    Select
                  </label>
                ) : (
                  <span />
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${caseStatusClass(item.status)}`}>{caseStatusLabel}</span>
                  {/* WHICH kind of closure this is (#569) — the status alone cannot say: a manual
                      close writes CLOSED while a rerun-verified one writes RESOLVED, and the run's
                      own auto-resolve writes RESOLVED too. */}
                  <ClosureKindChip item={item} />
                  <Badge variant={PRIORITY_BADGE_VARIANT[normalizeEnumValue(item.priority)] ?? "secondary"}>{priorityLabel}</Badge>
                </div>
              </div>

              <div className="mt-2">
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">{measureLabelFor(item.measureId, item.measureName)}</p>
                <h4 className="mt-1 text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                  <Link href={`/employees/${item.employeeId}`} className="hover:text-primary-700 hover:underline dark:hover:text-primary-400">
                    {item.employeeName}
                  </Link>
                </h4>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{item.employeeId}</p>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{item.site}</p>
              </div>

              <dl className="mt-4 space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-neutral-500 dark:text-neutral-400">Status</dt>
                  <dd className="font-medium">{caseStatusLabel}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-neutral-500 dark:text-neutral-400">Why flagged</dt>
                  <dd className="text-right">
                    {/* On a staff-closed row this is the WINNING RUN's answer, not the case column's
                        frozen one (#569), and the line beneath says who closed it and whether CQL
                        agrees. */}
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${outcomeStatusClass(displayOutcomeOf(item))}`}>
                      {labelFor(OUTCOME_LABELS, displayOutcomeOf(item))}
                    </span>
                    <StaffClosureNote item={item} className="mt-1" />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-neutral-500 dark:text-neutral-400">{isPatientTerm ? "Measurement year" : "Period"}</dt>
                  <dd className="font-medium">{isPatientTerm ? formatEvaluationPeriod(item.evaluationPeriod) : item.evaluationPeriod}</dd>
                </div>
                {item.slaRemainingDays != null ? (
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-neutral-500 dark:text-neutral-400">SLA</dt>
                    <SlaChip slaRemainingDays={item.slaRemainingDays} slaBreached={item.slaBreached} />
                  </div>
                ) : null}
                {caseStatus === "EXCLUDED" ? (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <dt className="text-neutral-500 dark:text-neutral-400">Exclusion reason</dt>
                      <dd className="max-w-[220px] text-right text-xs text-neutral-700 dark:text-neutral-300">
                        {item.exclusionReason ?? (isPatientTerm ? "Excluded by a documented exclusion." : "Excluded by active waiver or exemption.")}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-neutral-500 dark:text-neutral-400">{isPatientTerm ? "Exclusion" : "Waiver"}</dt>
                      <dd className="text-right text-xs font-medium text-neutral-700 dark:text-neutral-300">
                        {item.waiverExpiresAt ? (
                          <span className={`rounded-full px-2 py-1 ${item.waiverExpired ? "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300" : "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300"}`}>
                            {item.waiverExpired ? "Expired" : "Expires"} {new Date(item.waiverExpiresAt).toLocaleDateString()}
                          </span>
                        ) : (
                          "No expiry on file"
                        )}
                      </dd>
                    </div>
                  </>
                ) : null}
              </dl>

              <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">Updated {new Date(item.updatedAt).toLocaleString()}.</p>
              <Link href={`/cases/${item.caseId}`} className="mt-2 inline-block text-sm font-medium text-neutral-900 hover:underline dark:text-neutral-100">
                View structured evidence →
              </Link>
            </div>
          );
        })}
      </div>
      )}

      {hasMore ? (
        <div className="flex justify-center">
          <Button variant="outline" disabled={loadingMore} onClick={() => void loadMoreCases()}>
            {loadingMore ? "Loading…" : "Load more cases"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function CasesTable({
  items,
  selectedCaseIds,
  onToggle,
  canManage,
  measureLabelFor,
}: {
  items: CaseSummary[];
  selectedCaseIds: string[];
  onToggle: (caseId: string) => void;
  canManage: boolean;
  measureLabelFor: (measureId: string, fallbackName: string) => string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="hidden overflow-x-auto rounded-2xl border border-neutral-200 bg-white md:block dark:border-neutral-800 dark:bg-neutral-900">
      <table className="min-w-full text-sm">
        <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-400">
          <tr>
            {canManage ? <th scope="col" className="w-10 px-3 py-2" aria-label="Select" /> : null}
            <th scope="col" className="px-3 py-2">{SUBJECT.Singular}</th>
            <th scope="col" className="px-3 py-2">Measure</th>
            <th scope="col" className="px-3 py-2">Site</th>
            <th scope="col" className="px-3 py-2">Status</th>
            <th scope="col" className="px-3 py-2">Why flagged</th>
            <th scope="col" className="px-3 py-2">Priority</th>
            <th scope="col" className="px-3 py-2">Updated</th>
            <th scope="col" className="px-3 py-2" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.caseId}
              className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-800/60 dark:hover:bg-neutral-800/40"
            >
              {canManage ? (
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${item.employeeName}`}
                    checked={selectedCaseIds.includes(item.caseId)}
                    onChange={() => onToggle(item.caseId)}
                  />
                </td>
              ) : null}
              <td className="px-3 py-2">
                <Link
                  href={`/cases/${item.caseId}`}
                  className="font-medium text-neutral-900 hover:text-primary-700 hover:underline dark:text-neutral-100 dark:hover:text-primary-400"
                >
                  {item.employeeName}
                </Link>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{item.employeeId}</p>
              </td>
              <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{measureLabelFor(item.measureId, item.measureName)}</td>
              <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">{item.site}</td>
              <td className="px-3 py-2">
                <div className="flex flex-col items-start gap-1">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${caseStatusClass(item.status)}`}>
                    {labelFor(CASE_STATUS_LABELS, item.status)}
                  </span>
                  <ClosureKindChip item={item} />
                </div>
              </td>
              <td className="px-3 py-2">
                {/* The winning run's answer on a staff-closed row, with the closure line beneath — the
                    case column froze when the person closed it (#569). */}
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${outcomeStatusClass(displayOutcomeOf(item))}`}>
                  {labelFor(OUTCOME_LABELS, displayOutcomeOf(item))}
                </span>
                <StaffClosureNote item={item} className="mt-1" />
              </td>
              <td className="px-3 py-2">
                <Badge variant={PRIORITY_BADGE_VARIANT[normalizeEnumValue(item.priority)] ?? "secondary"}>
                  {labelFor(PRIORITY_LABELS, item.priority)}
                </Badge>
              </td>
              <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                {new Date(item.updatedAt).toLocaleDateString()}
              </td>
              <td className="px-3 py-2 text-right">
                <Link href={`/cases/${item.caseId}`} className="text-xs font-medium text-primary-700 hover:underline dark:text-primary-400">
                  View →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
