"use client";

/**
 * The patient work list (MM-2).
 *
 * `/worklist` used to redirect to `/cases`, on the reasoning that the work list IS the open-case
 * queue. Watching the practice use it showed the gap in that: `/cases` is one row per GAP, so a
 * patient with four open measures is four rows in four places, and the staffer calling them works one
 * and leaves three. This page is one row per PATIENT with every open gap on it, so a single call
 * closes what a single call can close.
 *
 * `/cases` is unchanged and still linked — it is the gap-centric view a supervisor wants when the
 * question is about a measure rather than about a person.
 *
 * **Default is WHOLE PRACTICE, not "my panel".** Panel→staff mappings do not exist yet (they are the
 * next change); defaulting to a panel nobody is mapped to would open this page on an empty list and
 * read as "no work".
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge, Button, Input, Select } from "@mieweb/ui";
import { ChevronRight } from "lucide-react";
import { emitToast } from "@/lib/toast";
import { OUTCOME_LABELS, PRIORITY_LABELS, labelFor, outcomeStatusClass } from "@/lib/status";
import { SUBJECT } from "@/lib/terminology";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useApi } from "@/lib/api/hooks";
import { SkeletonRow } from "@/components/skeleton-loader";
import { useAuth } from "@/components/auth-provider";
import { canManageCases } from "@/lib/rbac";
import { providerFilterLabel, usePanelProviders } from "@/features/panel/use-panel-providers";
import { UNASSIGN_VALUE, useAssignableUsers } from "@/features/panel/use-assignable-users";
import { payerFilterLabel, usePanelPayers } from "@/features/panel/use-panel-payers";

type WorklistGap = {
  caseId: string;
  measureId: string;
  measureName: string;
  status: string;
  outcomeStatus: string;
  priority: string;
  assignee: string | null;
  nextAction: string | null;
  evaluationPeriod: string;
  updatedAt: string;
  otherAssignee?: boolean;
};

type WorklistPatientRow = {
  employeeId: string;
  employeeName: string;
  site: string;
  providerId: string | null;
  providerName: string | null;
  payer: string | null;
  payerName: string | null;
  openGaps: WorklistGap[];
  gapCount: number;
  highestPriority: string;
  owner: string | null | "mixed";
  assignees: string[];
  updatedAt: string;
};

/** The bulk-assign contract (`POST /api/cases/bulk-assign`). */
type BulkAssignRequest = { assignee: string | null; caseIds: string[] };
/** What actually MOVED, which is not the same as what was asked for. */
type BulkAssignResult = { assigned: number; unchanged: number; missing: string[]; closed: string[] };

const PAGE_SIZES = [25, 50, 100].map((n) => ({ value: String(n), label: String(n) }));

export default function WorklistPage() {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const canManage = canManageCases(user?.role);
  const { siteId, from, to } = useGlobalFilters();

  const { options: providerOptions, nameFor: providerNameFor } = usePanelProviders();
  const { options: payerOptions, groups: payerGroups, available: payersAvailable, nameFor: payerNameFor } = usePanelPayers();
  const { options: assignableOptions, canonicalFor } = useAssignableUsers(canManage);

  const [rows, setRows] = useState<WorklistPatientRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkAssignee, setBulkAssignee] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(0);

  // URL is the state, so a filtered list is a link someone can send a colleague — which is what the
  // "saved filters" ask turned out to mean in practice.
  const providerFilter = searchParams.get("providerId")?.trim() ?? "";
  const assigneeFilter = searchParams.get("assignee")?.trim() ?? "";
  const outcomeFilter = searchParams.get("outcome")?.trim() ?? "";
  const measureFilter = searchParams.get("measureId")?.trim() ?? "";
  const searchFilter = searchParams.get("search")?.trim() ?? "";
  const payerFilter = useMemo(
    () => searchParams.getAll("payer").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean),
    [searchParams],
  );
  const [searchTerm, setSearchTerm] = useState(searchFilter);

  const setParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      setPage(0);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const togglePayer = useCallback(
    (code: string, on: boolean) => {
      setParams((params) => {
        const next = new Set(payerFilter);
        if (on) next.add(code);
        else next.delete(code);
        params.delete("payer");
        for (const value of [...next].sort()) params.append("payer", value);
      });
    },
    [payerFilter, setParams],
  );

  /** "Medicare (all)" — selects every code the roster actually has in that category. */
  const togglePayerGroup = useCallback(
    (codes: string[], on: boolean) => {
      setParams((params) => {
        const next = new Set(payerFilter);
        for (const code of codes) {
          if (on) next.add(code);
          else next.delete(code);
        }
        params.delete("payer");
        for (const value of [...next].sort()) params.append("payer", value);
      });
    },
    [payerFilter, setParams],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ status: "open", limit: String(pageSize), offset: String(page * pageSize) });
      if (providerFilter) params.set("providerId", providerFilter);
      if (assigneeFilter) params.set("assignee", assigneeFilter);
      if (outcomeFilter) params.set("outcome", outcomeFilter);
      if (measureFilter) params.set("measureId", measureFilter);
      if (searchFilter) params.set("search", searchFilter);
      if (siteId) params.set("site", siteId);
      for (const code of payerFilter) params.append("payer", code);
      const { data, headers } = await api.getWithHeaders<WorklistPatientRow[]>(`/api/worklist/patients?${params.toString()}`);
      setRows(data ?? []);
      setTotal(Number(headers.get("X-Total-Count") ?? data?.length ?? 0));
      // Drop selections whose patient is no longer on the list, so an assign cannot act on a row the
      // operator can no longer see.
      setSelected((existing) => existing.filter((id) => (data ?? []).some((r) => r.employeeId === id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [api, providerFilter, assigneeFilter, outcomeFilter, measureFilter, searchFilter, payerFilter, siteId, pageSize, page]);

  // Deferred a tick, matching `/cases`: the lint rule forbids a synchronous setState inside an effect
  // (it cascades renders), and `load` sets loading/rows/total on entry.
  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load, from, to]);

  const selectedRows = useMemo(() => rows.filter((r) => selected.includes(r.employeeId)), [rows, selected]);
  // The button says exactly what it will do: every ACTIVE gap of every selected patient, counted.
  const selectedGapIds = useMemo(() => selectedRows.flatMap((r) => r.openGaps.map((g) => g.caseId)), [selectedRows]);
  const allSelected = rows.length > 0 && rows.every((r) => selected.includes(r.employeeId));

  async function assignSelected() {
    if (selectedGapIds.length === 0 || bulkAssignee === "") return;
    const unassign = bulkAssignee === UNASSIGN_VALUE;
    if (!unassign && !canonicalFor(bulkAssignee)) {
      setError(`${bulkAssignee} is not an account cases can be assigned to.`);
      return;
    }
    setAssigning(true);
    setError(null);
    try {
      const result = await api.post<BulkAssignRequest, BulkAssignResult>(
        "/api/cases/bulk-assign",
        { assignee: unassign ? null : bulkAssignee, caseIds: selectedGapIds },
      );
      await load();
      const moved = result?.assigned ?? 0;
      emitToast(
        moved === 0
          ? "No gaps changed — they were already assigned that way"
          : unassign
            ? `${moved} gap${moved === 1 ? "" : "s"} unassigned`
            : `${moved} gap${moved === 1 ? "" : "s"} assigned to ${bulkAssignee}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setAssigning(false);
    }
  }

  const activeChips = useMemo(() => {
    const chips: string[] = [];
    if (providerFilter) chips.push(`${providerFilterLabel()}: ${providerNameFor(providerFilter) ?? providerFilter}`);
    // A chip never shows a bare typology code — "1" tells a reader nothing.
    for (const code of payerFilter) chips.push(`${payerFilterLabel}: ${payerNameFor(code) ?? code}`);
    if (assigneeFilter) chips.push(`Assignee: ${assigneeFilter}`);
    if (outcomeFilter) chips.push(`Status: ${labelFor(OUTCOME_LABELS, outcomeFilter)}`);
    return chips;
  }, [providerFilter, providerNameFor, payerFilter, payerNameFor, assigneeFilter, outcomeFilter]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Work list</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            One row per {SUBJECT.singular}, with every open gap. {total.toLocaleString()}{" "}
            {total === 1 ? SUBJECT.singular : SUBJECT.plural} with open gaps.
          </p>
        </div>
        <Link href="/cases" className="text-sm font-medium text-primary-700 hover:underline dark:text-primary-300">
          View by gap instead →
        </Link>
      </header>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
        <Select
          label={providerFilterLabel()}
          size="sm"
          className="w-56"
          value={providerFilter}
          onValueChange={(v) => setParams((p) => (v ? p.set("providerId", v) : p.delete("providerId")))}
          options={providerOptions}
        />
        <Select
          label="Assignee"
          size="sm"
          className="w-52"
          value={assigneeFilter}
          onValueChange={(v) => setParams((p) => (v ? p.set("assignee", v) : p.delete("assignee")))}
          options={[
            { value: "", label: "Anyone" },
            { value: "me", label: "Assigned to me" },
            { value: "unassigned", label: "Unassigned" },
            ...assignableOptions.filter((o) => o.value !== "" && o.value !== UNASSIGN_VALUE),
          ]}
        />
        <Select
          label="Gap status"
          size="sm"
          className="w-44"
          value={outcomeFilter}
          onValueChange={(v) => setParams((p) => (v ? p.set("outcome", v) : p.delete("outcome")))}
          options={[
            { value: "", label: "Any" },
            ...["OVERDUE", "DUE_SOON", "MISSING_DATA"].map((s) => ({ value: s, label: labelFor(OUTCOME_LABELS, s) })),
          ]}
        />
        <Input
          label="Search"
          size="sm"
          className="w-56"
          placeholder={`${SUBJECT.Singular} name or ID`}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setParams((p) => (searchTerm ? p.set("search", searchTerm) : p.delete("search")));
          }}
        />
        <Select
          label="Per page"
          size="sm"
          className="w-28"
          value={String(pageSize)}
          onValueChange={(v) => setPageSize(Number(v))}
          options={PAGE_SIZES}
        />
      </div>

      {/*
        Insurance is a MULTI-select, and the category rows are why. Medicare is two typology codes
        (`1` FFS and `11` Advantage); a single-choice control would let someone pick one and receive a
        list that silently omits the other, under a heading that says Medicare. Hidden entirely where
        the deployment's roster records no payer, rather than rendered empty.
      */}
      {payersAvailable ? (
        <fieldset className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
          <legend className="px-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">{payerFilterLabel}</legend>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {payerOptions.map((option) => (
              <label key={option.value} className="inline-flex items-center gap-2 text-sm text-neutral-800 dark:text-neutral-200">
                <input
                  type="checkbox"
                  checked={payerFilter.includes(option.value)}
                  onChange={(e) => togglePayer(option.value, e.target.checked)}
                />
                {option.label}
              </label>
            ))}
            {payerGroups.map((group) => {
              const all = group.codes.every((code) => payerFilter.includes(code));
              return (
                <Button
                  key={group.group}
                  size="sm"
                  variant={all ? "primary" : "outline"}
                  onClick={() => togglePayerGroup(group.codes, !all)}
                  title={`${group.groupName} is ${group.codes.length} codes on this roster: ${group.codes.join(", ")}`}
                >
                  {all ? `Clear ${group.groupName}` : `All ${group.groupName} (${group.subjectCount.toLocaleString()})`}
                </Button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {activeChips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {activeChips.map((chip) => (
            <Badge key={chip} variant="secondary">{chip}</Badge>
          ))}
          <button
            type="button"
            className="text-primary-700 hover:underline dark:text-primary-300"
            onClick={() => router.replace(pathname, { scroll: false })}
          >
            Clear filters
          </button>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-lg border border-danger-300 bg-danger-50 p-3 text-sm text-danger-800 dark:border-danger-800 dark:bg-danger-900/20 dark:text-danger-200">
          {error}
        </div>
      ) : null}

      {canManage && selected.length > 0 ? (
        <div className="rounded-xl border border-primary-200 bg-primary-50 p-3 dark:border-primary-800 dark:bg-primary-900/20">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-semibold text-primary-900 dark:text-primary-200">
              {selected.length} {SUBJECT.singular}
              {selected.length === 1 ? "" : "s"} selected
            </span>
            <Select
              label="Assignee for selected"
              hideLabel
              size="sm"
              className="w-64"
              value={bulkAssignee}
              onValueChange={setBulkAssignee}
              options={assignableOptions}
              disabled={assigning}
            />
            {/*
              The button names the SCOPE of what it does. "Assign selected" over a patient list is
              ambiguous — it is the patients' GAPS that get an assignee, and there are more of them
              than there are rows ticked.
            */}
            <Button size="sm" variant="primary" disabled={assigning || bulkAssignee === ""} onClick={() => void assignSelected()}>
              {assigning
                ? "Assigning…"
                : `Assign ${selectedGapIds.length} open gap${selectedGapIds.length === 1 ? "" : "s"}`}
            </Button>
            <button type="button" className="text-primary-800 hover:underline dark:text-primary-200" onClick={() => setSelected([])}>
              Clear selection
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            <tr>
              {canManage ? (
                <th className="w-10 p-3">
                  <input
                    type="checkbox"
                    aria-label={`Select all ${SUBJECT.plural} on this page`}
                    checked={allSelected}
                    onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.employeeId) : [])}
                  />
                </th>
              ) : null}
              <th className="p-3">{SUBJECT.Singular}</th>
              <th className="p-3">{providerFilterLabel()}</th>
              {payersAvailable ? <th className="p-3">{payerFilterLabel}</th> : null}
              <th className="p-3">Open gaps</th>
              <th className="p-3">Owner</th>
              <th className="w-10 p-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonRow />
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-neutral-500 dark:text-neutral-400">
                  No {SUBJECT.plural} with open gaps match these filters.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isExpanded = expanded.includes(row.employeeId);
                return (
                  <tr key={row.employeeId} className="border-b border-neutral-100 align-top last:border-0 dark:border-neutral-800">
                    {canManage ? (
                      <td className="p-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.employeeName}`}
                          checked={selected.includes(row.employeeId)}
                          onChange={(e) =>
                            setSelected((existing) =>
                              e.target.checked ? [...existing, row.employeeId] : existing.filter((id) => id !== row.employeeId),
                            )
                          }
                        />
                      </td>
                    ) : null}
                    <td className="p-3">
                      <Link href={`/employees/${encodeURIComponent(row.employeeId)}`} className="font-medium text-primary-700 hover:underline dark:text-primary-300">
                        {row.employeeName}
                      </Link>
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">{row.site}</div>
                    </td>
                    <td className="p-3 text-neutral-700 dark:text-neutral-300">{row.providerName ?? "—"}</td>
                    {payersAvailable ? <td className="p-3 text-neutral-700 dark:text-neutral-300">{row.payerName ?? "—"}</td> : null}
                    <td className="p-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={row.highestPriority === "HIGH" ? "danger" : "warning"}>
                          {row.gapCount} {labelFor(PRIORITY_LABELS, row.highestPriority)}
                        </Badge>
                        {(isExpanded ? row.openGaps : row.openGaps.slice(0, 3)).map((gap) => (
                          <Link
                            key={gap.caseId}
                            href={`/cases/${encodeURIComponent(gap.caseId)}`}
                            className={`rounded px-1.5 py-0.5 text-xs ${outcomeStatusClass(gap.outcomeStatus)} ${gap.otherAssignee ? "opacity-60" : ""}`}
                            title={
                              gap.otherAssignee
                                ? `${gap.measureName} — ${labelFor(OUTCOME_LABELS, gap.outcomeStatus)} (assigned to ${gap.assignee ?? "nobody"}, not the filtered assignee)`
                                : `${gap.measureName} — ${labelFor(OUTCOME_LABELS, gap.outcomeStatus)}${gap.nextAction ? `: ${gap.nextAction}` : ""}`
                            }
                          >
                            {gap.measureName}
                          </Link>
                        ))}
                        {!isExpanded && row.openGaps.length > 3 ? (
                          <button
                            type="button"
                            className="text-xs text-primary-700 hover:underline dark:text-primary-300"
                            onClick={() => setExpanded((e) => [...e, row.employeeId])}
                          >
                            +{row.openGaps.length - 3} more
                          </button>
                        ) : null}
                      </div>
                    </td>
                    <td className="p-3 text-neutral-700 dark:text-neutral-300">
                      {/*
                        "Mixed" is a real answer: a patient whose gaps belong to different people has
                        no owner, and naming one of them would say the rest are handled.
                      */}
                      {row.owner === "mixed" ? (
                        <span title={row.assignees.join(", ")}>Mixed ({row.assignees.length})</span>
                      ) : (
                        (row.owner ?? "Unassigned")
                      )}
                    </td>
                    <td className="p-3">
                      <Link href={`/employees/${encodeURIComponent(row.employeeId)}`} aria-label={`Open ${row.employeeName}`}>
                        <ChevronRight className="h-4 w-4 text-neutral-400" />
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-neutral-600 dark:text-neutral-400">
        <span>
          {total === 0 ? "No results" : `${page * pageSize + 1}–${Math.min(total, (page + 1) * pageSize)} of ${total.toLocaleString()}`}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Previous
          </Button>
          <Button size="sm" variant="outline" disabled={loading || (page + 1) * pageSize >= total} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
