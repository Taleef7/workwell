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
 * **The default view depends on whether the viewer owns a panel** (ADR-080 d5). Someone mapped to at
 * least one provider opens on "My panel" — the patients they are actually responsible for, which is
 * how the practice divides the work. Someone mapped to none (a supervisor, or anyone before the
 * mappings are made) opens on the whole practice, because defaulting them to an empty panel would
 * read as "no work". The URL always wins once it says which view is wanted.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { usePanelAssignments } from "@/features/panel/use-panel-assignments";
import { PanelsTab } from "@/features/panel/PanelsTab";

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
type BulkAssignResult = {
  assigned: number;
  unchanged: number;
  /** Read as changing, then lost to a concurrent write. NOT applied — the opposite of `unchanged`. */
  conflicted: number;
  missing: string[];
  closed: string[];
};

const PAGE_SIZES = [25, 50, 100].map((n) => ({ value: String(n), label: String(n) }));

/**
 * What one bulk-assign request may carry. The SERVER enforces the real limit and answers 400 naming
 * it (`BULK_ASSIGN_MAX` in `backend-ts/src/routes/worklist.ts`); this copy exists only so the button
 * can say why it is disabled instead of letting someone click it and read a raw API error.
 *
 * It is reachable, not theoretical: a page of 100 patients on a deployment routing six measures is up
 * to 600 gaps, and the header select-all takes the page.
 */
const BULK_ASSIGN_MAX = 500;

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
  // Read on every visit because it answers the default-view question, not only the Panels tab's rows —
  // and owned HERE, once, so a save inside the tab updates the chip the page draws. Two instances meant
  // two requests and a chip that still said "none assigned to me" straight after you assigned one.
  const {
    rows: panelRows,
    loading: panelsLoading,
    error: panelsError,
    ownsPanel,
    mine: myPanels,
    save: savePanel,
    remove: removePanel,
  } = usePanelAssignments(user?.email, true);

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
  const requestSeq = useRef(0);

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
  /** "patients" (default) or "panels" — the tab strip, kept in the URL so a link opens the same view. */
  const tab = searchParams.get("tab")?.trim() === "panels" ? "panels" : "patients";
  /**
   * Which view the URL asks for: "me", "all", or nothing said yet.
   *
   * The third state is the one that matters. Absent means "nobody has chosen", which is what lets the
   * default below depend on whether this viewer owns a panel; an explicit `panel=all` is a choice and
   * must survive, or a mapped staff member could never look at the whole practice.
   */
  const panelParam = searchParams.get("panel")?.trim().toLowerCase();
  const panelFilter = panelParam === "me" ? "me" : panelParam === "all" ? "all" : null;
  const [searchTerm, setSearchTerm] = useState(searchFilter);

  /**
   * The query string as last written, which is not the same as this render's `searchParams`.
   *
   * Two filter interactions can land before the router re-renders, and the second must build on the
   * first rather than replace it — ticking Medicare then Medicare Advantage left only Advantage.
   * `window.location.search` is not the fix either: `router.replace` updates it asynchronously, so it
   * is as stale as the snapshot and empty under test. A ref updated at the moment we write is the one
   * thing that is current in both.
   *
   * **Deliberately untested, and said out loud rather than covered by a test that proves nothing.**
   * The jsdom harness cannot reproduce this: its `next/navigation` mock updates the params
   * synchronously inside `replace`, and `fireEvent`/`userEvent` flush React between clicks, so the
   * second handler always sees fresh state whether or not this ref exists. A test was written, both
   * spellings passed it, and it was removed — a green assertion over a race the harness defines away
   * is worse than none.
   */
  const paramsRef = useRef(searchParams.toString());
  useEffect(() => {
    // Re-sync when the URL changes from outside this component (back/forward, a nav link).
    paramsRef.current = searchParams.toString();
  }, [searchParams]);

  const setParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(paramsRef.current);
      mutate(params);
      paramsRef.current = params.toString();
      setPage(0);
      router.replace(`${pathname}?${paramsRef.current}`, { scroll: false });
    },
    [pathname, router],
  );

  /**
   * The view actually being shown.
   *
   * The URL wins whenever it says anything. When it does not, a viewer who owns a panel gets theirs
   * and everyone else gets the whole practice — and while `ownsPanel` is still `undefined` (the
   * mappings have not loaded) the answer is "whole practice", because guessing "My panel" before we
   * know would flash an empty list at a supervisor who owns none.
   */
  const effectivePanel: "me" | "all" = panelFilter ?? (ownsPanel ? "me" : "all");

  /**
   * Write the default into the URL ONCE, after the mappings resolve, so the page's address describes
   * what it is showing — a link someone sends a colleague opens the same list.
   *
   * Only when the URL says nothing: an explicit choice, in either direction, is never overwritten.
   *
   * **The redirect itself is deliberately not unit-tested**, for the reason the params ref above
   * records: the jsdom `next/navigation` mock updates synchronously, so a test here would pass over
   * either spelling. The two RENDERED states — mapped viewer sees "My panel", unmapped sees "Whole
   * practice" — are tested, which is the behaviour that matters.
   */
  useEffect(() => {
    if (panelParam !== undefined && panelParam !== null) return;
    if (ownsPanel !== true) return;
    // Deferred a tick for the same reason `load` is: a synchronous setState inside an effect cascades
    // renders, and `setParams` sets the page back to zero as well as writing the URL.
    const timer = setTimeout(() => setParams((params) => params.set("panel", "me")), 0);
    return () => clearTimeout(timer);
  }, [ownsPanel, panelParam, setParams]);

  /**
   * Add or remove payer codes.
   *
   * The set is rebuilt from the params object `setParams` hands us — the URL as it stands right now —
   * rather than from `payerFilter`, which is this render's snapshot. Two checkbox clicks land faster
   * than `searchParams` updates, so reading the snapshot made the second click clobber the first:
   * ticking Medicare then Medicare Advantage left only Advantage, which is the omission this whole
   * multi-select exists to prevent.
   */
  const togglePayerCodes = useCallback(
    (codes: readonly string[], on: boolean) => {
      setParams((params) => {
        // From the params object `setParams` hands us — the last-written URL — not from `payerFilter`,
        // which is this render's snapshot and does not yet include a click that just happened.
        const next = new Set(params.getAll("payer").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean));
        for (const code of codes) {
          if (on) next.add(code);
          else next.delete(code);
        }
        params.delete("payer");
        for (const value of [...next].sort()) params.append("payer", value);
      });
    },
    [setParams],
  );
  const togglePayer = useCallback((code: string, on: boolean) => togglePayerCodes([code], on), [togglePayerCodes]);
  /** "Medicare (all)" — every code the roster actually has in that category. */
  const togglePayerGroup = togglePayerCodes;

  const load = useCallback(async () => {
    // Nothing is fetched until the view is DECIDED. When the URL says nothing, `effectivePanel` reads
    // "all" while the mappings are in flight, so loading immediately meant a mapped staffer's first
    // paint was a whole-practice query — several thousand other people's patients, flashed on screen
    // and then replaced by their own panel, plus a second heavy query to do it.
    if (panelFilter === null && ownsPanel === undefined) return;
    // A request sequence, like /cases has: typing in the search box fires several of these, and without
    // it a slower earlier response resolves last and overwrites the current rows with stale ones.
    const ticket = (requestSeq.current += 1);
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
      // The dashboard's date range is rendered on every page, so it must either apply here or not be
      // read at all — a refetch that visibly runs and returns the same list looks like it worked.
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      for (const code of payerFilter) params.append("payer", code);
      // Only "me" is sent: "all" is the ABSENCE of a panel constraint, and spelling it out would make
      // the server resolve a filter it is about to ignore.
      if (effectivePanel === "me") params.set("panel", "me");
      const { data, headers } = await api.getWithHeaders<WorklistPatientRow[]>(`/api/worklist/patients?${params.toString()}`);
      if (ticket !== requestSeq.current) return;
      setRows(data ?? []);
      setTotal(Number(headers.get("X-Total-Count") ?? data?.length ?? 0));
      // Drop selections whose patient is no longer on the list, so an assign cannot act on a row the
      // operator can no longer see.
      setSelected((existing) => existing.filter((id) => (data ?? []).some((r) => r.employeeId === id)));
    } catch (err) {
      if (ticket !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setRows([]);
      setTotal(0);
    } finally {
      if (ticket === requestSeq.current) setLoading(false);
    }
  }, [api, providerFilter, assigneeFilter, outcomeFilter, measureFilter, searchFilter, payerFilter, effectivePanel, panelFilter, ownsPanel, siteId, from, to, pageSize, page]);

  // Deferred a tick, matching `/cases`: the lint rule forbids a synchronous setState inside an effect
  // (it cascades renders), and `load` sets loading/rows/total on entry.
  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const selectedRows = useMemo(() => rows.filter((r) => selected.includes(r.employeeId)), [rows, selected]);
  // The button says exactly what it will do: every ACTIVE gap of every selected patient, counted.
  const selectedGapIds = useMemo(() => selectedRows.flatMap((r) => r.openGaps.map((g) => g.caseId)), [selectedRows]);
  const allSelected = rows.length > 0 && rows.every((r) => selected.includes(r.employeeId));
  const overBulkCap = selectedGapIds.length > BULK_ASSIGN_MAX;
  // How many of the selected gaps currently belong to someone OTHER than the target. The grouping goes
  // to trouble to mark those in the list (dimmed, with a tooltip); taking them without a word would
  // undo that — a filtered "assigned to me" view plus select-all silently reassigns colleagues' work.
  const takingFromOthers = useMemo(() => {
    const target = bulkAssignee === UNASSIGN_VALUE ? null : bulkAssignee || null;
    return selectedRows
      .flatMap((r) => r.openGaps)
      .filter((g) => g.assignee && g.assignee !== target).length;
  }, [selectedRows, bulkAssignee]);

  async function assignSelected() {
    if (selectedGapIds.length === 0 || bulkAssignee === "" || selectedGapIds.length > BULK_ASSIGN_MAX) return;
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
      // Clear the selection: the patients still have open gaps, so `load` keeps them on the list and
      // the action bar would stay live over work that is already done — inviting a second click whose
      // only outcome is "no gaps changed".
      setSelected([]);
      setBulkAssignee("");
      const moved = result?.assigned ?? 0;
      // The toast reports what HAPPENED. Saying "already assigned that way" over gaps a run closed
      // between the page load and the click is the one explanation that is definitely wrong, and the
      // one that stops someone looking further.
      const skipped = (result?.closed?.length ?? 0) + (result?.missing?.length ?? 0);
      // A CONFLICT is not a skip and not a no-op: somebody else moved the row while this operator was
      // deciding, so the assignment they asked for was NOT applied and the gap now belongs to a third
      // person. Folding it into "already assigned that way" told them the opposite of what happened,
      // and folding it into "skipped" would suggest the row was closed or gone, which it is not.
      const conflicted = result?.conflicted ?? 0;
      const parts: string[] = [];
      if (skipped > 0) parts.push(`${skipped} skipped — already closed or no longer present`);
      if (conflicted > 0) {
        parts.push(
          `${conflicted} not applied — reassigned by someone else while you were choosing`,
        );
      }
      const tail = parts.length > 0 ? ` (${parts.join("; ")})` : "";
      emitToast(
        moved === 0
          ? parts.length > 0
            ? `No gaps changed${tail}`
            : "No gaps changed — they were already assigned that way"
          : unassign
            ? `${moved} gap${moved === 1 ? "" : "s"} unassigned${tail}`
            : `${moved} gap${moved === 1 ? "" : "s"} assigned to ${bulkAssignee}${tail}`,
        // A conflict is something the operator has to look at, not a success they can ignore.
        conflicted > 0 ? "error" : "success",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setAssigning(false);
    }
  }

  const activeChips = useMemo(() => {
    const chips: string[] = [];
    // Named, not just "My panel": a staffer who owns four providers should see which four, and someone
    // who owns none should see that the heading is describing an empty set rather than a quiet failure.
    if (effectivePanel === "me") {
      chips.push(
        myPanels.length === 0
          ? "My panel: none assigned to me"
          : `My panel: ${myPanels.map((id) => providerNameFor(id) ?? id).join(", ")}`,
      );
    }
    if (providerFilter) chips.push(`${providerFilterLabel()}: ${providerNameFor(providerFilter) ?? providerFilter}`);
    // A chip never shows a bare typology code — "1" tells a reader nothing.
    for (const code of payerFilter) chips.push(`${payerFilterLabel}: ${payerNameFor(code) ?? code}`);
    if (assigneeFilter) chips.push(`Assignee: ${assigneeFilter}`);
    if (outcomeFilter) chips.push(`Status: ${labelFor(OUTCOME_LABELS, outcomeFilter)}`);
    return chips;
  }, [effectivePanel, myPanels, providerFilter, providerNameFor, payerFilter, payerNameFor, assigneeFilter, outcomeFilter]);

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

      {/* Two questions, two tabs: whose gaps are open, and who works whose patients. */}
      <div className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800" role="tablist" aria-label="Work list views">
        {([["patients", SUBJECT.Plural], ["panels", "Panels"]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setParams((params) => (key === "patients" ? params.delete("tab") : params.set("tab", key)))}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === key
                ? "border-primary-600 text-primary-700 dark:border-primary-400 dark:text-primary-300"
                : "border-transparent text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "panels" ? (
        <PanelsTab
          rows={panelRows}
          loading={panelsLoading}
          error={panelsError}
          canManage={canManage}
          assignableOptions={assignableOptions}
          canonicalFor={canonicalFor}
          onSave={async (providerId, assignee) => {
            const result = await savePanel(providerId, assignee);
            // The patient list behind this tab is now describing a different set of owners.
            void load();
            return result;
          }}
          onRemove={async (providerId) => {
            await removePanel(providerId);
            void load();
          }}
        />
      ) : (
      <>
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
        <Select
          label="View"
          size="sm"
          className="w-44"
          value={effectivePanel}
          onValueChange={(v) => setParams((params) => params.set("panel", v))}
          options={[
            { value: "me", label: "My panel" },
            { value: "all", label: "Whole practice" },
          ]}
        />
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
          onValueChange={(v) => {
            // Back to the first page: keeping the offset across a size change asks for rows past the
            // end — an empty list under a footer reading "301–200 of 200".
            setPage(0);
            setPageSize(Number(v));
          }}
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
          {/*
            The counts are the ROSTER's, not this list's — `/api/payers` counts every subject in the
            deployment with that payer, deliberately, so an option does not vanish because nobody on
            it has an open gap today. Said on the label, because "All Medicare (6,827)" sitting above
            "240 patients with open gaps" otherwise reads as a promise about the list below it.
          */}
          <legend className="px-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
            {payerFilterLabel} <span className="font-normal">— counts are {SUBJECT.plural} on the roster, not open gaps</span>
          </legend>
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
            onClick={() => {
              setPage(0);
              router.replace(pathname, { scroll: false });
            }}
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
            <Button
              size="sm"
              variant="primary"
              disabled={assigning || bulkAssignee === "" || overBulkCap}
              onClick={() => void assignSelected()}
            >
              {assigning
                ? "Assigning…"
                : `Assign ${selectedGapIds.length} open gap${selectedGapIds.length === 1 ? "" : "s"}`}
            </Button>
            {/*
              Stated rather than enforced silently: a disabled button with no reason is the same
              puzzle as a control that does nothing. One request keeps the assign atomic, so the fix
              is to select fewer rather than to split it into calls that can half-fail.
            */}
            {overBulkCap ? (
              <span className="text-xs text-danger-700 dark:text-danger-300">
                Too many for one assignment ({selectedGapIds.length} gaps, limit {BULK_ASSIGN_MAX}) — select fewer
                {SUBJECT.plural} or reduce the page size.
              </span>
            ) : null}
            {takingFromOthers > 0 && !overBulkCap ? (
              <span className="text-xs text-warning-800 dark:text-warning-300">
                {takingFromOthers} of {selectedGapIds.length} currently belong to someone else.
              </span>
            ) : null}
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
                        // NOT `assignees.length` — that excludes the unassigned gaps, so a patient with
                        // one assigned gap and one without rendered "Mixed (1)", a count that
                        // contradicts its own label and hides the gap nobody owns. Say what is mixed.
                        <span title={row.assignees.join(", ") || undefined}>
                          {row.assignees.length === 0
                            ? "Mixed"
                            : row.gapCount > row.assignees.length && row.openGaps.some((g) => !g.assignee)
                              ? `Mixed (${row.assignees.length} + unassigned)`
                              : `Mixed (${row.assignees.length})`}
                        </span>
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
      </>
      )}
    </div>
  );
}
