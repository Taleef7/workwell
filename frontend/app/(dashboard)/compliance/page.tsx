"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/lib/api/hooks";
import { fmtCount } from "@/lib/format";
import { useRunStatus } from "@/components/run-status-provider";
import { useGlobalFilters } from "@/components/global-filter-context";
import { useAuth } from "@/components/auth-provider";
import { canManageCases, canRunMeasures } from "@/lib/rbac";
import { emitToast } from "@/lib/toast";
import { canSeeEngineering } from "@/lib/public-demo";
import { COMPLIANCE_STATUS_LABELS } from "@/lib/status";
import { SUBJECT } from "@/lib/terminology";
import { providerFilterLabel, usePanelProviders } from "@/features/panel/use-panel-providers";
import { payerFilterLabel, usePanelPayers } from "@/features/panel/use-panel-payers";
import { Button } from "@mieweb/ui";
import { UNASSIGN_VALUE, useAssignableUsers } from "@/features/panel/use-assignable-users";
import { ComplianceChip } from "@/features/compliance/ComplianceChip";
import { RosterMobileCards } from "@/features/compliance/RosterMobileCards";
import { usePanelCache } from "@/features/compliance/usePanelCache";
import { SLOW_LOAD_HINT, useSlowLoadHint } from "@/lib/useSlowLoadHint";
import { useMeasureIdentities } from "@/lib/measure-identity";
import { PANEL_OPTIONS, type DisplayState, type PanelId, type Roster, type TenantOption } from "@/features/compliance/types";

const STATUS_FILTER_OPTIONS = Object.keys(COMPLIANCE_STATUS_LABELS);
const STATUS_FILTER_VALUES = new Set(STATUS_FILTER_OPTIONS);
const PAGE_SIZES = [25, 50, 100, 200];

function normalizeStatusFilter(raw: string | null): string {
  return raw && STATUS_FILTER_VALUES.has(raw) ? raw : "";
}

/** The bands the backend accepts (compliance/subject-filters.ts). Kept in this order for the select. */
const AGE_BAND_OPTIONS = ["0-17", "18-44", "45-64", "65+"] as const;

/**
 * Which roster cell states can have an ACTIVE case, and therefore which rows are worth ticking.
 *
 * **DECLINED belongs here, and leaving it out was a real defect** caught by three reviewers. A
 * documented refusal does not change the canonical bucket — `roster-vocabulary.ts` applies DECLINED
 * only when the canonical status is NOT compliant, and `MEASURES.md` says a declination "keeps the
 * case open". So a nurse filtering the roster for patients who refused a vaccine, which is exactly
 * the list worth calling, would have found every one of those checkboxes dead.
 *
 * COMPLIANT has nothing open. EXCLUDED is a closed outcome. NA is "not evaluated". NOT_APPLICABLE is
 * the segment overlay and is excluded as POLICY rather than because no case exists — a subject who
 * left a cohort keeps their open case (DATA_MODEL_CONTRACTS §4: resolution is never segment-gated),
 * and out-of-cohort wins over any real outcome in the read model, so the cell cannot say what the
 * underlying status is. Assigning work the roster is actively refusing to describe is the wrong
 * default; the work list shows those rows.
 *
 * Module scope, so the `useMemo` dependency comment below is TRUE — it was declared inside the
 * component and rebuilt every render, which made the eslint-disable justification false.
 */
const ASSIGNABLE_CELL_STATES: ReadonlySet<DisplayState> = new Set<DisplayState>([
  "OVERDUE",
  "DUE_SOON",
  "MISSING_DATA",
  "IN_PROGRESS",
  "DECLINED",
]);

function normalizePanelFilter(raw: string | null): PanelId {
  return raw && PANEL_OPTIONS.some((option) => option.id === raw)
    ? (raw as PanelId)
    : "immunizations";
}

export default function CompliancePage() {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { startTracking, isActive } = useRunStatus();
  // Site scoping comes from the shared dashboard site selector (header) / `?site=` URL — same as the
  // cases & programs pages — not a page-local field, so the global filter actually applies here.
  const { siteId } = useGlobalFilters();
  const canRecalc = canRunMeasures(user?.role) && canSeeEngineering(user?.role);
  const { labelFor: measureLabelFor } = useMeasureIdentities();

  // Derived from the URL rather than useState-initialized, so browser back/forward between two
  // filtered /compliance URLs re-renders with the right filter.
  const panel: PanelId = normalizePanelFilter(searchParams.get("panel"));
  const status: string = normalizeStatusFilter(searchParams.get("status"));
  const measureId: string = searchParams.get("measureId") ?? "";
  // The pilot's panel filters (spec §5). URL-derived like panel/status/measureId, so a deep link into
  // one PCP's panel — which is how a status chip drills down — renders filtered, and browser
  // back/forward between two filtered rosters works without any page-local state to fall out of sync.
  const providerId: string = searchParams.get("providerId") ?? "";
  const ageBand: string = searchParams.get("ageBand") ?? "";
  const sex: string = searchParams.get("sex") ?? "";
  /**
   * Primary payer, as a SET — the practice asked to work a panel by insurance, and the typology is
   * hierarchical, so a single-valued control would let someone ask for Medicare and silently receive
   * only traditional Medicare while 2,900 Medicare Advantage patients were withheld under a heading
   * claiming to contain them (DATA_MODEL_CONTRACTS §6.3). Same semantics as the work list.
   */
  const payerFilter = useMemo(
    () => searchParams.getAll("payer").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean),
    [searchParams],
  );
  /**
   * Assigning from the roster (#567).
   *
   * A roster CELL is an outcome reference, not a case — so "assign these" has no meaning until a
   * measure is named, and a patient ROW spans every routed column. The control therefore appears
   * only while exactly one measure is in scope, and it means: that measure's ACTIVE case for each
   * selected patient. The server resolves those case ids from `{ measureId, subjectIds }` and is the
   * authority on which patients actually have one — the selectability rule below is an affordance so
   * nobody ticks a row that cannot move, not a correctness guard.
   */
  const canAssignFromRoster = canManageCases(user?.role);
  const { options: assignableOptions, canonicalFor, hasAccounts } = useAssignableUsers(canAssignFromRoster);
  /**
   * The selection carries the WHOLE VIEW it was made in, not just the measure.
   *
   * The first cut tagged only `measureId`, and three reviewers found the same two holes in it. Tick
   * Alice, filter her away, then remove the filter: she is back in `selectableIds`, so she silently
   * returns to the selection and would be POSTed. And ticking ten rows on page 1, paging to page 2 and
   * pressing Assign posted only page 2's, discarding ten deliberate ticks without a word.
   *
   * Scoping to the full view answers both: any change to the measure, panel, status, site, panel
   * filters, insurance, search, segment, tenant or page empties the selection, and the bar says
   * "Select patients…" again rather than holding rows nobody can see. Selection is per view, which is
   * the only version of this that never assigns something the operator is not looking at.
   *
   * A tag, not an effect: clearing in an effect is a synchronous setState in an effect body, which
   * `react-hooks/set-state-in-effect` forbids for the reason it exists.
   */
  const [selection, setSelection] = useState<{ scope: string; ids: string[] }>({ scope: "", ids: [] });
  const [bulkAssignee, setBulkAssignee] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [q, setQ] = useState<string>("");
  const [segment, setSegment] = useState<string>("");
  const [segmentOptions, setSegmentOptions] = useState<{ id: string; name: string }[]>([]);
  // URL-derived, like panel/status/measureId — a programs chip is tenant-scoped when the System
  // selector is set, so its deep link has to be able to SAY so or the destination list cannot
  // reproduce the count that was clicked.
  const tenant: string = searchParams.get("tenant") ?? "";
  const setTenant = useCallback((next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("tenant", next);
    else params.delete("tenant");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);
  const [tenantOptions, setTenantOptions] = useState<TenantOption[]>([]);
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(50);

  // A global site change can shrink the result set so the current page slices to empty
  // ("No employees match" / "Page 5 of 1"). Jump back to page 1 the moment siteId changes — the
  // React-documented "adjust state during render when a value changes" pattern, so `load` rebuilds with
  // page=1 before it fires (no stale out-of-range request, no double fetch). The selects/search/page-size
  // controls already reset the page in their own onChange; this covers the externally-driven site filter.
  const [prevSiteId, setPrevSiteId] = useState(siteId);
  if (siteId !== prevSiteId) {
    setPrevSiteId(siteId);
    setPage(1);
  }

  // panel/status are URL-derived, so like siteId they can change externally (back/forward, deep link),
  // not only through their selects — the same render-adjust reset covers both paths.
  const [prevPanel, setPrevPanel] = useState(panel);
  const [prevStatus, setPrevStatus] = useState(status);
  const [prevSubjectFilters, setPrevSubjectFilters] = useState(`${providerId}|${ageBand}|${sex}|${payerFilter.join(",")}`);
  const subjectFilterKey = `${providerId}|${ageBand}|${sex}|${payerFilter.join(",")}`;
  if (panel !== prevPanel || status !== prevStatus || subjectFilterKey !== prevSubjectFilters) {
    setPrevPanel(panel);
    setPrevStatus(status);
    setPrevSubjectFilters(subjectFilterKey);
    setPage(1);
  }

  // Debounce the free-text search so a fetch fires once the typing settles, not per keystroke
  // (matches the cases page). The selects + paging + global site filter drive `load` immediately.
  const [debouncedQ, setDebouncedQ] = useState<string>("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const [roster, setRoster] = useState<Roster | null>(null);
  const [loadedPanel, setLoadedPanel] = useState<PanelId | null>(null);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [recalcBusy, setRecalcBusy] = useState<boolean>(false);

  // UX-3 — optimistic panel/filter caching: keep each fetched (panel + filters + page) result in memory
  // for the session, keyed by its full query signature. Switching a panel/filter — or switching *back*
  // to one already loaded — renders instantly from cache instead of re-paying the cold roster fetch and
  // re-showing a blank skeleton. Session-scoped (unmounts with the page); a recompute clears it below.
  const cache = usePanelCache<{ roster: Roster; total: number }>();
  const slow = useSlowLoadHint(loading);

  // Stale-fetch guard (Fable M20): a slow All-Systems response must not land after a fast tenant=ihn
  // one and paint the wrong rows under the selected filter. Only the latest load applies its result.
  const reqIdRef = useRef(0);
  const load = useCallback(async () => {
    const params = new URLSearchParams();
    params.set("panel", panel);
    if (status) params.set("status", status);
    if (measureId.trim()) params.set("measureId", measureId.trim());
    if (siteId.trim()) params.set("site", siteId.trim());
    if (providerId) params.set("providerId", providerId);
    if (ageBand) params.set("ageBand", ageBand);
    if (sex) params.set("sex", sex);
    for (const code of payerFilter) params.append("payer", code);
    if (debouncedQ.trim()) params.set("q", debouncedQ.trim());
    if (segment) params.set("segment", segment);
    if (tenant) params.set("tenant", tenant);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    const query = params.toString();

    // Cache hit → paint instantly, never a blank skeleton for data already fetched this session. Bump
    // the request id so any in-flight fetch for a prior key can't land on top of the cached result.
    const cached = cache.read(query);
    if (cached) {
      reqIdRef.current++;
      setRoster(cached.roster);
      setLoadedPanel(panel);
      setTotal(cached.total);
      setError(null);
      setLoading(false);
      return;
    }

    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const { data, headers } = await api.getWithHeaders<Roster>(`/api/compliance/roster?${query}`);
      if (reqId !== reqIdRef.current) return;
      setRoster(data);
      setLoadedPanel(panel);
      const matchTotal = Number(headers.get("X-Total-Count") ?? data.rows.length);
      const resolvedTotal = Number.isFinite(matchTotal) ? matchTotal : data.rows.length;
      setTotal(resolvedTotal);
      cache.write(query, { roster: data, total: resolvedTotal });
    } catch (err) {
      if (reqId !== reqIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load the compliance roster.");
      setRoster(null);
      setLoadedPanel(null);
      setTotal(0);
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [api, cache, panel, status, measureId, siteId, providerId, ageBand, sex, payerFilter, debouncedQ, segment, tenant, page, pageSize]);

  useEffect(() => {
    // Defer out of the synchronous effect body (matches cases/page.tsx) so the load's setState calls
    // don't trip react-hooks/set-state-in-effect.
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    // A recompute makes every cached panel/filter stale — drop the whole cache so the reload actually
    // re-fetches the current key (and future switches re-fetch too) instead of serving pre-run data.
    const onComplete = () => {
      cache.clear();
      void load();
    };
    window.addEventListener("ww:run-complete", onComplete);
    return () => window.removeEventListener("ww:run-complete", onComplete);
  }, [load, cache]);

  // Load the enabled segments once for the optional Segment filter. Best-effort: the filter is
  // optional and must never break the roster, so swallow errors and leave the options empty. The
  // setState rides in the async .then so it doesn't trip react-hooks/set-state-in-effect.
  useEffect(() => {
    api
      .get<{ id: string; name: string; enabled: boolean }[]>("/api/segments")
      .then((list) =>
        setSegmentOptions((Array.isArray(list) ? list : []).filter((s) => s.enabled).map(({ id, name }) => ({ id, name })))
      )
      .catch(() => setSegmentOptions([]));
  }, [api]);

  // Load the tenants/systems once for the optional Tenant filter (E13 PR-1). Best-effort, like segments.
  useEffect(() => {
    api
      .get<TenantOption[]>("/api/tenants")
      .then((list) => setTenantOptions(Array.isArray(list) ? list : []))
      .catch(() => setTenantOptions([]));
  }, [api]);

  const recalculate = useCallback(async () => {
    if (!canRecalc || isActive) return; // a run is already in flight — don't fan out a duplicate
    if (!window.confirm(`Recalculate compliance for all programs? This runs every active measure across the ${SUBJECT.population}.`)) return;
    setRecalcBusy(true);
    try {
      const result = await api.post<{ scopeType: string }, { runId: string; status?: string }>(
        "/api/runs/manual",
        { scopeType: "ALL_PROGRAMS" }
      );
      startTracking(result.runId, result.status ?? "REQUESTED");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the recalculation run.");
    } finally {
      setRecalcBusy(false);
    }
  }, [api, canRecalc, isActive, startTracking]);

  // `keepMeasureId` distinguishes the server canonicalizing the panel (a chip deep link whose measure
  // lives in another panel — the scope must survive) from a person choosing a panel (the measure
  // scope no longer applies).
  const writePanelToUrl = useCallback((nextPanel: PanelId, replace = false, keepMeasureId = false) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("panel", nextPanel);
    if (!keepMeasureId) params.delete("measureId");
    const query = params.toString();
    const target = query ? `${pathname}?${query}` : pathname;
    if (replace) {
      router.replace(target);
    } else {
      router.push(target);
    }
  }, [pathname, router, searchParams]);

  const clearMeasureId = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("measureId");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams]);

  const setPanelAndUrl = useCallback((nextPanel: PanelId) => {
    writePanelToUrl(nextPanel, false);
  }, [writePanelToUrl]);

  useEffect(() => {
    if (roster && loadedPanel === panel && roster.panel !== panel) {
      writePanelToUrl(roster.panel, true, true);
    }
  }, [roster, loadedPanel, panel, writePanelToUrl]);

  const setStatusAndUrl = useCallback((nextStatus: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextStatus) {
      params.set("status", nextStatus);
    } else {
      params.delete("status");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams]);

  /** One writer for the three panel filters — the same shape `setStatusAndUrl` uses. */
  const setSubjectFilter = useCallback((key: "providerId" | "ageBand" | "sex", value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams]);

  /**
   * Add or remove payer codes.
   *
   * Unlike the single-valued filters above, this one reads the LAST-WRITTEN url rather than this
   * render's `searchParams`. Two checkbox clicks land faster than `searchParams` updates, so reading
   * the snapshot makes the second click clobber the first — ticking Medicare then Medicare Advantage
   * leaves only Advantage, which is the omission a multi-select exists to prevent. The work list hit
   * exactly this and the fix is the same ref.
   *
   * Deliberately NOT unit-tested: the jsdom `next/navigation` mock updates `useParams`/
   * `useSearchParams` synchronously, so a test passes over either spelling and would pin nothing
   * (JOURNAL 2026-09-12). Mutation-checked by hand instead.
   */
  const payerParamsRef = useRef<string>(searchParams.toString());
  useEffect(() => {
    payerParamsRef.current = searchParams.toString();
  }, [searchParams]);
  const togglePayerCodes = useCallback((codes: readonly string[], on: boolean) => {
    const params = new URLSearchParams(payerParamsRef.current);
    const next = new Set(params.getAll("payer").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean));
    for (const code of codes) {
      if (on) next.add(code);
      else next.delete(code);
    }
    params.delete("payer");
    for (const value of [...next].sort()) params.append("payer", value);
    payerParamsRef.current = params.toString();
    const query = payerParamsRef.current;
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router]);

  const clearSubjectFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of ["providerId", "ageBand", "sex", "payer"]) params.delete(key);
    payerParamsRef.current = params.toString();
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams]);

  // The PCP list, the option order and the PCP-versus-Provider wording are shared with the case list
  // (`features/panel/use-panel-providers`) — three things that would drift silently if each surface
  // fetched its own. The markup is not shared: this page renders native selects, that one renders the
  // design system's.
  const { providers: providerOptions, nameFor: providerNameFor } = usePanelProviders();
  const { options: payerOptions, groups: payerGroups, available: payersAvailable, nameFor: payerNameFor } = usePanelPayers();

  const columns = roster?.columns ?? [];
  const rows = roster?.rows ?? [];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Server-side, and only when ONE measure is in scope: a patient that measure does not describe is
  // not work (ADR-078). Reported rather than dropped in silence.
  const notInPopulation = roster?.notInPopulation ?? 0;
  const emptyPanels = roster?.availablePanels !== undefined && roster.availablePanels.length === 0;


  const assignMeasureId = measureId.trim();
  /**
   * Everything that decides WHICH rows are on screen. A change to any of it invalidates a tick.
   *
   * `pageSize` belongs here for the same reason `page` does, and Codex caught its absence: select row
   * 40 at size 50, switch to 25, switch back, and the tick returns — because only `selectedHere` was
   * filtering it out meanwhile. Every pagination control has to invalidate, not just the page number.
   */
  const selectionScopeKey = [assignMeasureId, panel, status, siteId, providerId, ageBand, sex, payerFilter.join(","), debouncedQ, segment, tenant, page, pageSize].join("|");
  /** One measure in scope, a seat that may assign, and a list of accounts to assign to. */
  // `hasAccounts`, never `assignableOptions.length` — that is always at least two (a placeholder and
  // "Unassign"), so the length test was a guard that could not fire, and with the endpoint returning
  // nothing the bar still rendered offering only to CLEAR assignments. Caught in review; it is also
  // the mutation four earlier rounds missed, because deleting a dead clause changes nothing.
  const assignEnabled = Boolean(assignMeasureId) && canAssignFromRoster && hasAccounts;
  const selectableIds = useMemo(
    () => (
      assignEnabled
        ? rows
            .filter((r) => ASSIGNABLE_CELL_STATES.has((r.cells[assignMeasureId]?.status ?? "NA") as DisplayState))
            .map((r) => r.subject.externalId)
        : []
    ),
    [assignEnabled, rows, assignMeasureId],
  );
  // The CURRENT view, readable from an async continuation that closed over an older one. Written in
  // an effect, not during render — React 19 forbids the latter, and an effect is the right place
  // anyway: the value only has to be correct by the time an await resumes.
  const scopeRef = useRef(selectionScopeKey);
  useEffect(() => {
    scopeRef.current = selectionScopeKey;
  }, [selectionScopeKey]);
  const selectedHere = useMemo(
    () => (selection.scope === selectionScopeKey ? selection.ids.filter((id) => selectableIds.includes(id)) : []),
    [selection, selectionScopeKey, selectableIds],
  );
  const allSelectableSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedHere.includes(id));
  const toggleOne = useCallback((externalId: string, on: boolean) => {
    setSelection((current) => {
      const ids = current.scope === selectionScopeKey ? current.ids : [];
      const next = new Set(ids);
      if (on) next.add(externalId);
      else next.delete(externalId);
      return { scope: selectionScopeKey, ids: [...next] };
    });
  }, [selectionScopeKey]);
  const toggleAll = useCallback((on: boolean) => {
    setSelection({ scope: selectionScopeKey, ids: on ? [...selectableIds] : [] });
  }, [selectionScopeKey, selectableIds]);

  const assignSelected = useCallback(async () => {
    if (!assignEnabled || selectedHere.length === 0 || !bulkAssignee) return;
    const unassign = bulkAssignee === UNASSIGN_VALUE;
    if (!unassign && !canonicalFor(bulkAssignee)) {
      setError(`${bulkAssignee} is not an account cases can be assigned to.`);
      return;
    }
    setAssigning(true);
    setError(null);
    try {
      const result = await api.post<
        { assignee: string | null; measureId: string; subjectIds: string[] },
        { assigned?: number; unchanged?: number; conflicted?: number; missing?: string[]; closed?: string[] }
      >("/api/cases/bulk-assign", {
        assignee: unassign ? null : bulkAssignee,
        measureId: assignMeasureId,
        subjectIds: selectedHere,
      });
      cache.clear();
      // Only reload if the operator is still looking at the view this assignment was made in.
      //
      // `load` is the callback captured when the button was clicked. If a filter or page changed
      // while the POST was in flight, calling it re-runs the OLD query, bumps `reqIdRef` so the newer
      // view's own request is discarded as stale, and repaints the previous roster underneath the new
      // URL and filter controls — with nothing left to correct it. Caught by Codex on the PR.
      //
      // The scope key is read from a ref rather than the closure for the same reason: the closure's
      // copy is the one from click time, which is exactly what cannot be trusted here.
      if (scopeRef.current === selectionScopeKey) {
        await load();
      }
      setSelection({ scope: selectionScopeKey, ids: [] });
      setBulkAssignee("");
      const moved = result?.assigned ?? 0;
      const conflicted = result?.conflicted ?? 0;
      // Reports what HAPPENED. A selection where nobody had an active case for this measure is 0 and
      // says so, rather than claiming success over work that did not exist.
      const tail = conflicted > 0 ? ` (${conflicted} not applied — reassigned by someone else while you were choosing)` : "";
      emitToast(
        moved === 0
          ? `No ${SUBJECT.plural} had an open case for this measure.`
          : `${moved} ${moved === 1 ? "case" : "cases"} ${unassign ? "unassigned" : `assigned to ${bulkAssignee}`}${tail}`,
        moved === 0 ? "info" : "success",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Assignment failed");
    } finally {
      setAssigning(false);
    }
  }, [api, assignEnabled, assignMeasureId, bulkAssignee, cache, canonicalFor, load, selectedHere, selectionScopeKey]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Individual Compliance Status</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {`Every ${SUBJECT.singular} across the selected panel — compliant and excluded included. The inverse of the worklist.`}
          </p>
        </div>
        {canRecalc ? (
          <button
            type="button"
            onClick={recalculate}
            disabled={recalcBusy || isActive}
            title={isActive ? "A run is already in progress" : undefined}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {isActive ? "Run in progress…" : recalcBusy ? "Starting…" : "Recalculate"}
          </button>
        ) : null}
      </header>

      {emptyPanels ? (
        <p className="rounded-lg border border-neutral-200 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800">
          No compliance panel is configured for this deployment.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <label className="flex flex-col text-xs font-medium">
              <span className="mb-1">Panel</span>
              <select
                aria-label="Panel"
                value={loadedPanel === panel ? (roster?.panel ?? panel) : panel}
                onChange={(e) => setPanelAndUrl(e.target.value as PanelId)}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
              >
              {(roster?.availablePanels
                ? PANEL_OPTIONS.filter((p) => roster.availablePanels!.includes(p.id))
                : PANEL_OPTIONS
              ).map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
            </select>
          </label>
          {canSeeEngineering(user?.role) && (
            <label className="flex flex-col text-xs font-medium">
              <span className="mb-1">System</span>
              <select
                aria-label="System"
                value={tenant}
                onChange={(e) => { setPage(1); setTenant(e.target.value); }}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
              >
                <option value="">All systems</option>
                {tenantOptions.map((o) => (<option key={o.id} value={o.id}>{o.name}</option>))}
              </select>
            </label>
          )}
          <label className="flex flex-col text-xs font-medium">
            <span className="mb-1">Segment</span>
            <select
              aria-label="Segment"
              value={segment}
              onChange={(e) => { setPage(1); setSegment(e.target.value); }}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            >
              <option value="">All segments</option>
              {segmentOptions.map((o) => (<option key={o.id} value={o.id}>{o.name}</option>))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium">
            <span className="mb-1">Status</span>
            <select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatusAndUrl(e.target.value)}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            >
              <option value="">All statuses</option>
              {STATUS_FILTER_OPTIONS.map((s) => (<option key={s} value={s}>{COMPLIANCE_STATUS_LABELS[s]}</option>))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium">
            <span className="mb-1">{providerFilterLabel()}</span>
            <select
              aria-label={providerFilterLabel()}
              value={providerId}
              onChange={(e) => setSubjectFilter("providerId", e.target.value)}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            >
              <option value="">All panels</option>
              {providerOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.name} — {o.location}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium">
            <span className="mb-1">Age</span>
            <select
              aria-label="Age"
              value={ageBand}
              onChange={(e) => setSubjectFilter("ageBand", e.target.value)}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            >
              <option value="">All ages</option>
              {AGE_BAND_OPTIONS.map((b) => (<option key={b} value={b}>{b}</option>))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium">
            <span className="mb-1">Sex</span>
            <select
              aria-label="Sex"
              value={sex}
              onChange={(e) => setSubjectFilter("sex", e.target.value)}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            >
              <option value="">All</option>
              <option value="F">Female</option>
              <option value="M">Male</option>
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium">
            <span className="mb-1">Search</span>
            <input
              value={q}
              onChange={(e) => { setPage(1); setQ(e.target.value); }}
              placeholder="Name or ID"
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            />
          </label>
          <label className="flex flex-col text-xs font-medium">
            <span className="mb-1">Page size</span>
            <select
              aria-label="Page size"
              value={pageSize}
              onChange={(e) => { setPage(1); setPageSize(Number(e.target.value)); }}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
            >
              {PAGE_SIZES.map((n) => (<option key={n} value={n}>{n}</option>))}
            </select>
          </label>
        </div>

        {/*
          The insurance control the practice asked for ON THIS SCREEN (#567). It existed only on the
          work list, which from the other side of the call is indistinguishable from not existing:
          the ask was "filter for a provider, a measure, an insurance, then assign that report", and
          two of those three were already here.

          Hidden when the deployment records no payer at all, rather than rendered empty — the
          occupational directory has never carried one.
        */}
        {payersAvailable ? (
          <fieldset className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
            <legend className="px-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
              {payerFilterLabel} <span className="font-normal">— counts are {SUBJECT.plural} on the roster</span>
            </legend>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {payerOptions.map((option) => (
                <label key={option.value} className="inline-flex items-center gap-2 text-sm text-neutral-800 dark:text-neutral-200">
                  <input
                    type="checkbox"
                    checked={payerFilter.includes(option.value)}
                    onChange={(e) => { setPage(1); togglePayerCodes([option.value], e.target.checked); }}
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
                    onClick={() => { setPage(1); togglePayerCodes(group.codes, !all); }}
                    title={`${group.groupName} is ${group.codes.length} codes on this roster: ${group.codes.join(", ")}`}
                  >
                    {all ? `Clear ${group.groupName}` : `All ${group.groupName} (${group.subjectCount.toLocaleString()})`}
                  </Button>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        {providerId || ageBand || sex || payerFilter.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
            <span>Filtered to</span>
            {providerId ? (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
                {providerNameFor(providerId) ?? providerId}
              </span>
            ) : null}
            {ageBand ? (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
                Age {ageBand}
              </span>
            ) : null}
            {sex ? (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
                {sex === "F" ? "Female" : "Male"}
              </span>
            ) : null}
            {payerFilter.map((code) => (
              <span key={code} className="rounded-full bg-neutral-100 px-2 py-0.5 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
                {payerFilterLabel}: {payerNameFor(code) ?? code}
              </span>
            ))}
            <button
              type="button"
              onClick={clearSubjectFilters}
              className="font-medium text-primary-700 hover:underline dark:text-primary-400"
            >
              Clear
            </button>
          </div>
        ) : null}

        {measureId ? (
          <div className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
            <span>
              Scoped to{" "}
              <span className="font-semibold text-neutral-900 dark:text-neutral-100">
                {measureLabelFor(measureId, measureId)}
              </span>
            </span>
            <span>—</span>
            <button
              type="button"
              onClick={clearMeasureId}
              className="font-medium text-primary-700 hover:underline dark:text-primary-400"
            >
              Clear
            </button>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="rounded border border-rose-300 bg-rose-50 p-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </p>
        ) : null}

        <span className="sr-only" role="status" aria-live="polite">
          {loading ? (slow ? `${SLOW_LOAD_HINT} Still loading.` : "Loading roster…") : `${rows.length} ${rows.length === 1 ? SUBJECT.singular : SUBJECT.plural} loaded`}
        </span>

        {slow && loading ? (
          <p className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
            <span aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
            {SLOW_LOAD_HINT}
          </p>
        ) : null}

        {/*
          The assign affordance the 2026-09-10 call asked for ON THIS SCREEN — "filter for a provider,
          a measure, an insurance, then assign that report". It appears only with ONE measure in scope,
          because a roster cell is an outcome reference and a patient row spans every column, so
          "assign these" is ambiguous until a measure is named.
        */}
        {assignEnabled ? (
          // `md:flex`, because every selection checkbox lives in the desktop table (`hidden md:block`)
          // and `RosterMobileCards` has none. Below `md` this bar rendered a live-looking control with
          // nothing on screen able to change its state — a vacuous control, and on a tablet, which is
          // what the pilot's quality lead is most likely to open. Selection on the mobile cards is the
          // better answer and is its own piece of work.
          <div className="hidden flex-wrap items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm md:flex dark:border-neutral-800 dark:bg-neutral-900/60">
            <span className="font-medium">
              {selectedHere.length === 0
                ? `Select ${SUBJECT.plural} to assign their ${measureLabelFor(assignMeasureId, assignMeasureId)} case`
                : `${selectedHere.length} selected`}
            </span>
            <label className="flex items-center gap-2">
              <span className="sr-only">Assign to</span>
              <select
                aria-label="Assign to"
                value={bulkAssignee}
                onChange={(e) => setBulkAssignee(e.target.value)}
                disabled={selectedHere.length === 0 || assigning}
                className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
              >
                {/* The hook already supplies its own placeholder as `options[0]`; a hardcoded one
                    here rendered TWO options with `value=""`. */}
                {assignableOptions.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
              </select>
            </label>
            <Button
              size="sm"
              onClick={() => { void assignSelected(); }}
              disabled={selectedHere.length === 0 || !bulkAssignee || assigning}
            >
              {assigning ? "Assigning…" : "Assign selected"}
            </Button>
            {/*
              Says what "selected" can mean here, because the checkbox column is deliberately dead on
              rows with nothing open — a compliant patient is not work, and an out-of-population one
              has no case at all (ADR-078).
            */}
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {`${selectableIds.length} of ${rows.length} on this page have an open case for this measure`}
            </span>
          </div>
        ) : null}

        <div className="hidden overflow-x-auto rounded-lg border border-neutral-200 md:block dark:border-neutral-800">
          <table className="min-w-full border-collapse text-sm">
            <thead className="bg-neutral-50 dark:bg-neutral-900/60">
              <tr>
                {assignEnabled ? (
                  <th scope="col" className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select all ${SUBJECT.plural} with an open case`}
                      checked={allSelectableSelected}
                      disabled={selectableIds.length === 0}
                      onChange={(e) => toggleAll(e.target.checked)}
                    />
                  </th>
                ) : null}
                <th scope="col" className="sticky left-0 z-10 bg-neutral-50 px-3 py-2 text-left font-semibold dark:bg-neutral-900/60">
                  {SUBJECT.Singular}
                </th>
                {columns.map((c) => (
                  <th key={c.measureId} scope="col" className="px-3 py-2 text-left font-semibold">
                    {measureLabelFor(c.measureId, c.name)}
                    <span className="ml-1 text-[10px] font-normal uppercase text-neutral-400">{c.complianceClass === "PERMANENT" ? "perm" : "rec"}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={columns.length + (assignEnabled ? 2 : 1)} className="px-3 py-6 text-center text-neutral-500">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={columns.length + (assignEnabled ? 2 : 1)} className="px-3 py-6 text-center text-neutral-500">{`No ${SUBJECT.plural} match these filters.`}</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.subject.externalId} className="border-t border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900/40">
                    {assignEnabled ? (
                      <td className="px-3 py-2 align-top">
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.subject.name}`}
                          checked={selectedHere.includes(r.subject.externalId)}
                          disabled={!selectableIds.includes(r.subject.externalId)}
                          onChange={(e) => toggleOne(r.subject.externalId, e.target.checked)}
                        />
                      </td>
                    ) : null}
                    <th scope="row" className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-normal dark:bg-neutral-950">
                      <Link href={`/employees/${encodeURIComponent(r.subject.externalId)}`} className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                        {r.subject.name}
                      </Link>
                      <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        {r.subject.tenantName} · {r.subject.site}{SUBJECT.singular === "patient" ? null : <> · {r.subject.role}</>}
                      </div>
                    </th>
                    {columns.map((c) => {
                      const cell = r.cells[c.measureId] ?? { status: "NA" as const, method: "Not evaluated" };
                      return (
                        <td key={c.measureId} className="px-3 py-2 align-top">
                          <ComplianceChip cell={cell} />
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <RosterMobileCards columns={columns} rows={rows} loading={loading} labelFor={measureLabelFor} />

        <div className="flex items-center justify-between text-sm text-neutral-500 dark:text-neutral-400">
          <span>
            {fmtCount(total)} {total === 1 ? SUBJECT.singular : SUBJECT.plural}
            {notInPopulation > 0 ? (
              <span className="ml-2 text-neutral-400 dark:text-neutral-500">
                ({fmtCount(notInPopulation)} not in this measure&apos;s population)
              </span>
            ) : null}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-50 dark:border-neutral-700"
            >
              Prev
            </button>
            <span>Page {page} of {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage((p) => (p < totalPages ? p + 1 : p))}
              disabled={page >= totalPages}
              className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-50 dark:border-neutral-700"
            >
              Next
            </button>
          </div>
        </div>
        </>
      )}
    </div>
  );
}
