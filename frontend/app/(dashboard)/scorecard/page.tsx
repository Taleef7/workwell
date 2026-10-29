"use client";

/**
 * The provider × measure quality scorecard (#852).
 *
 * The practice works per provider and per location, so this is each measure's rate for each provider's
 * patients, a subtotal per location and the practice total, as CMS computes a rate: the numerator over
 * the denominator less its exclusions and exceptions, never an average of percentages. A count of open
 * gaps opens the work list on exactly those patients.
 *
 * Deliberately absent: a ranking and any colour against a target. There is no agreed benchmark yet, and
 * a red cell would claim one. A rate on fewer than 20 patients is dimmed and says so, not hidden.
 *
 * The year, the panel and the chosen provider live in the URL, so a reload keeps the view and a scorecard
 * sent to a colleague opens on the same year and provider. "My providers" is always the viewer's own, so it
 * travels as a choice, not as someone else's panel. Choosing a provider narrows what is drawn and asks the
 * server for nothing new: the card already holds every row.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button, Select } from "@mieweb/ui";
import { useApi } from "@/lib/api/hooks";
import { useAuth } from "@/components/auth-provider";
import { canManageCases } from "@/lib/rbac";
import { SUBJECT } from "@/lib/terminology";
import { AccessDenied } from "@/components/access-denied";
import { ScrollRegion } from "@/components/scroll-region";
import { RateEstimateNote } from "@/components/rate-estimate-note";
import { useMeasureIdentities, type ScoringLogic } from "@/lib/measure-identity";
import { worklistHref } from "@/lib/worklist-links";
import { usePanelAssignments } from "@/features/panel/use-panel-assignments";

type ColumnState = "complete" | "no_run" | "compacted" | "data_insufficient" | "mixed_logic" | "period_mismatch";

interface ScorecardMeasure {
  measureId: string;
  name: string;
  state: ColumnState;
  runStartedAt: string | null;
  executedLogic: string | null;
  logic: ScoringLogic | null;
  numeratorMeansCompliant: boolean | null;
}

interface ScorecardRate {
  label: string | null;
  numer: number;
  effectiveDenominator: number;
  score: number | null;
  smallNumber: boolean;
}

interface ScorecardCell {
  rates: ScorecardRate[] | null;
  openGaps: number | null;
}

interface ScorecardRow {
  providerId: string | null;
  name: string;
  cells: Record<string, ScorecardCell>;
}

interface Scorecard {
  measurementYear: number;
  generatedAt: string;
  smallNumberThreshold: number;
  openGapsShown: boolean;
  panel: { requested: "me" | "all"; ownsPanel: boolean };
  measures: ScorecardMeasure[];
  locations: Array<{ location: string; providers: ScorecardRow[]; subtotal: ScorecardRow }>;
  other: ScorecardRow | null;
  total: ScorecardRow;
}

/** Why a column states no rate, in the practice's words. */
const REFUSED: Record<Exclude<ColumnState, "complete">, string> = {
  no_run: "No run for this year yet",
  compacted: "The run is past the retention cutoff",
  data_insufficient: "The run's data was too thin to trust",
  mixed_logic: "The run was scored by two different logics",
  period_mismatch: "The run holds another year's results",
};

const pct = (score: number | null): string => (score === null ? "—" : `${(score * 100).toFixed(1)}%`);

/** The newest run date any column was scored from: "the run of <date>" in the note. */
function runDateOf(card: Scorecard): string | null {
  const dates = card.measures.map((m) => m.runStartedAt).filter((d): d is string => d !== null).sort();
  const newest = dates.at(-1);
  return newest ? new Date(newest).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : null;
}

/** Every provider row in the card, as the picker offers it. "Other" is not a provider and is not offered. */
function providerOptions(card: Scorecard): { value: string; label: string }[] {
  return [
    { value: "", label: "All providers" },
    ...card.locations.flatMap((l) =>
      l.providers.flatMap((p) => (p.providerId ? [{ value: p.providerId, label: `${p.name} — ${l.location}` }] : [])),
    ),
  ];
}

/**
 * The rows both layouts draw, so the table and the phone cards can never disagree about what is shown.
 *
 * With a provider chosen: that provider's row, its location's subtotal and the total, each exactly as the
 * server stated it. The subtotal and the total still cover everyone they did, so the provider reads against
 * their location and the practice rather than against totals rebuilt from one row. "Other" (patients whose
 * PCP the directory does not list) belongs to no provider and goes with the other locations.
 *
 * `missing` is a provider the URL names that this card does not hold: outside "My providers", or with
 * nothing to show for this year.
 */
function rowsFor(card: Scorecard, providerId: string): { locations: Scorecard["locations"]; other: ScorecardRow | null; missing: boolean } {
  if (!providerId) return { locations: card.locations, other: card.other, missing: false };
  for (const location of card.locations) {
    const row = location.providers.find((p) => p.providerId === providerId);
    if (row) return { locations: [{ ...location, providers: [row] }], other: null, missing: false };
  }
  return { locations: [], other: null, missing: true };
}

/** A four-digit year no later than this one; anything else is the current year, as with no year at all. */
function yearFrom(raw: string | null, thisYear: number): number {
  const value = raw?.trim() ?? "";
  return /^[1-9]\d{3}$/.test(value) && Number(value) <= thisYear ? Number(value) : thisYear;
}

export default function ScorecardPage() {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const mayView = canManageCases(user?.role);
  const { compactLabelFor, titleFor } = useMeasureIdentities();
  // Only asked for by a role that may read the page, so a VIEWER's refused visit sends nothing at all.
  const { ownsPanel } = usePanelAssignments(user?.email, mayView);
  const thisYear = new Date().getUTCFullYear();
  const year = yearFrom(searchParams.get("year"), thisYear);
  // A link can name an older year than the two offered (one sent in December, opened in January). It stays
  // in the list, so the control says which year is shown instead of naming another.
  const yearOptions = [thisYear, thisYear - 1];
  if (!yearOptions.includes(year)) yearOptions.push(year);
  const providerParam = searchParams.get("provider")?.trim() ?? "";
  /**
   * Which view the URL asks for: "me", "all", or nothing said yet. Absent is what lets the default below
   * depend on whether this viewer owns a panel, as the work list's does; an explicit `panel=all` is a
   * choice and survives, or a staffer who owns a panel could never see the whole practice.
   */
  const panelValue = searchParams.get("panel")?.trim().toLowerCase();
  const panelParam = panelValue === "me" ? "me" : panelValue === "all" ? "all" : null;
  /**
   * The view being shown. An explicit `panel=all` always wins. "My providers" is only ever the VIEWER's own
   * providers, so it is shown only to someone who owns a panel, whether the URL asks for it or says
   * nothing: a `panel=me` link opened by someone who owns none (a panel owner's copied link, sent on)
   * shows the whole practice. Obeying it served them an empty card with no control to leave it, since the
   * toggle is only drawn for an owner. Nothing is fetched while that is still unknown (see `load`).
   */
  const effectivePanel: "me" | "all" = panelParam === "all" ? "all" : ownsPanel ? "me" : "all";
  const decided = panelParam === "all" || ownsPanel !== undefined;
  const [card, setCard] = useState<Scorecard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * The query string as last written, for the reason the work list records at length: two writes can land
   * before the router re-renders, and the second must build on the first rather than replace it. Untested
   * for the same reason too: the jsdom `next/navigation` mock updates synchronously, so a test would pass
   * with or without the ref.
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
      router.replace(`${pathname}?${paramsRef.current}`, { scroll: false });
    },
    [pathname, router],
  );

  /**
   * Make the address say what the page shows, ONCE, after the mappings resolve: the owner's default
   * becomes `panel=me`, and a `panel=me` the viewer cannot have becomes `panel=all`. An explicit
   * `panel=all` is never overwritten, nor an owner's `panel=me`.
   *
   * **The redirect itself is deliberately not unit-tested**, as on the work list: the jsdom
   * `next/navigation` mock updates synchronously, so a test would pass over either spelling. What it
   * decides is tested where it shows, in the panel the first request asks for.
   */
  useEffect(() => {
    const target = ownsPanel === true && panelParam === null ? "me" : ownsPanel === false && panelParam === "me" ? "all" : null;
    if (!target) return;
    // Deferred a tick for the same reason `load` is: a synchronous setState inside an effect cascades renders.
    const timer = setTimeout(() => setParams((params) => params.set("panel", target)), 0);
    return () => clearTimeout(timer);
  }, [ownsPanel, panelParam, setParams]);

  // Only the newest request may write: switching year or panel while a slow answer is in flight must not
  // let the older one land on top of the newer.
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    // Nothing is fetched until the view is DECIDED. While the mappings are in flight `effectivePanel`
    // reads "all", so loading at once would show a staffer who owns a panel the whole practice first and
    // then replace it with their own providers, at the cost of a second full read. Keyed on `decided`
    // rather than on `ownsPanel` and the URL's value, so writing the default into the URL (which
    // changes neither the view nor the answer) does not fetch the same card twice.
    if (!decided) return;
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.get<Scorecard>(`/api/scorecard?measurementYear=${year}&panel=${effectivePanel}`);
      if (request === requestRef.current) setCard(next);
    } catch (err) {
      if (request !== requestRef.current) return;
      setCard(null);
      setError(err instanceof Error ? err.message : "The scorecard could not be loaded.");
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [api, year, effectivePanel, decided]);

  useEffect(() => {
    if (!mayView) return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load, mayView]);

  if (!mayView) {
    return (
      <AccessDenied
        title="Quality scorecard"
        message="Each provider's rates are the practice's performance figures, read by Case Managers and Admins — your role doesn't have access."
      />
    );
  }

  const header = (m: ScorecardMeasure) => ({
    label: compactLabelFor(m.measureId, m.name, m.logic),
    title: titleFor(m.measureId, m.name, m.logic),
  });
  const runDate = card ? runDateOf(card) : null;
  // From the server's clock, after the fetch: never rendered on the server, so it cannot mismatch on hydration.
  const printedMonth = card ? new Date(card.generatedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", timeZone: "UTC" }) : "";
  const totalName = card?.panel.requested === "me" ? "My providers" : "Practice total";
  const shown = card ? rowsFor(card, providerParam) : null;

  return (
    <section className="scorecard space-y-4">
      <p className="print-only text-lg font-semibold">Quality scorecard — {printedMonth}</p>
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Quality scorecard</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Each measure&apos;s rate for each provider&apos;s {SUBJECT.plural}, by location
            {card ? `, for ${card.measurementYear}` : ""}.
          </p>
          {loading && card ? <p className="text-xs text-neutral-500" role="status">Loading {year}…</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            Year
            <select
              aria-label="Measurement year"
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
              value={year}
              onChange={(e) => setParams((params) => params.set("year", e.target.value))}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
          {/* Offered from the card itself, so it lists exactly the providers this view has rows for. The
              placeholder shows only for a provider the URL names and the card does not hold. */}
          {card ? (
            <Select
              label="Provider"
              hideLabel
              size="sm"
              className="w-64"
              value={providerParam}
              placeholder="Not in this view"
              onValueChange={(v) => setParams((params) => (v ? params.set("provider", v) : params.delete("provider")))}
              options={providerOptions(card)}
            />
          ) : null}
          {card?.panel.ownsPanel ? (
            <div role="group" aria-label="Which providers" className="flex gap-1">
              <Button
                size="sm"
                variant={effectivePanel === "all" ? "primary" : "outline"}
                aria-pressed={effectivePanel === "all"}
                onClick={() => setParams((params) => params.set("panel", "all"))}
              >
                Whole practice
              </Button>
              <Button
                size="sm"
                variant={effectivePanel === "me" ? "primary" : "outline"}
                aria-pressed={effectivePanel === "me"}
                onClick={() => setParams((params) => params.set("panel", "me"))}
              >
                My providers
              </Button>
            </div>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => window.print()} disabled={!card}>
            Print
          </Button>
        </div>
      </div>

      <div className="space-y-1 text-xs text-neutral-600 dark:text-neutral-400" data-testid="scorecard-note">
        <p>
          {runDate ? `From WorkWell's run of ${runDate}. ` : ""}
          Each {SUBJECT.singular} counts under their PCP on file. A rate is the numerator over the denominator less its
          exclusions and exceptions; totals add the counts, never the percentages. A rate on fewer than{" "}
          {card?.smallNumberThreshold ?? 20} {SUBJECT.plural} is dimmed.
        </p>
        <RateEstimateNote />
      </div>

      {error ? <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{error}</p> : null}
      {loading && !card ? <p className="text-sm text-neutral-500">Loading…</p> : null}

      {/* The URL's provider is kept, never quietly dropped: switching to the whole practice may well show
          them. Until then nothing is drawn in their place, because rows for everyone under a link that
          named one provider would read as that provider's figures. */}
      {shown?.missing ? (
        <div
          role="status"
          data-testid="scorecard-provider-missing"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <span>This provider is not in this view.</span>
          <Button size="sm" variant="outline" onClick={() => setParams((params) => params.delete("provider"))}>
            Show all providers
          </Button>
        </div>
      ) : null}

      {card && shown ? (
        card.locations.length === 0 && !card.other ? (
          <div className="space-y-2 text-sm text-neutral-500" data-testid="scorecard-empty">
            <p>
              {card.panel.requested === "me"
                ? `None of your providers' ${SUBJECT.plural} were counted for ${card.measurementYear}.`
                : `No ${SUBJECT.plural} were counted for ${card.measurementYear} yet.`}
            </p>
            {/* A year whose every column was refused has no rows to draw a table on, so the reasons go here. */}
            {card.measures.some((m) => m.state !== "complete") ? (
              <ul className="list-disc pl-5" data-testid="scorecard-empty-reasons">
                {card.measures
                  .filter((m) => m.state !== "complete")
                  .map((m) => (
                    <li key={m.measureId}>
                      {header(m).label}: {REFUSED[m.state as Exclude<ColumnState, "complete">]}
                    </li>
                  ))}
              </ul>
            ) : null}
          </div>
        ) : shown.missing ? null : (
          <>
            <ScrollRegion label="Quality scorecard table" className="hidden rounded-lg border border-neutral-200 md:block print:block dark:border-neutral-800 dark:[--scroll-cue-bg:var(--color-neutral-950)]">
              <table className="min-w-full border-collapse text-sm" data-testid="scorecard-table">
                <thead className="bg-neutral-50 dark:bg-neutral-900/60">
                  <tr>
                    <th scope="col" className="sticky left-0 z-10 bg-neutral-50 px-3 py-2 text-left font-semibold dark:bg-neutral-900">
                      Provider
                    </th>
                    {card.measures.map((m) => (
                      <th key={m.measureId} scope="col" className="px-3 py-2 text-left align-bottom font-semibold" title={header(m).title}>
                        {header(m).label}
                        {m.executedLogic ? <span className="block text-[10px] font-normal text-neutral-500">{m.executedLogic}</span> : null}
                        {m.numeratorMeansCompliant === false ? (
                          <span className="block text-[10px] font-normal text-neutral-500">Lower is better</span>
                        ) : null}
                        {m.state !== "complete" ? (
                          <span data-testid={`scorecard-refused-${m.measureId}`} className="block text-[10px] font-normal text-amber-700 dark:text-amber-400">
                            {REFUSED[m.state]}
                          </span>
                        ) : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.locations.map((l) => (
                    <LocationRows key={l.location} location={l} measures={card.measures} openGapsShown={card.openGapsShown} threshold={card.smallNumberThreshold} panel={card.panel.requested} />
                  ))}
                  {shown.other ? (
                    <Row row={shown.other} measures={card.measures} openGapsShown={card.openGapsShown} threshold={card.smallNumberThreshold} panel={card.panel.requested} kind="other" />
                  ) : null}
                  <Row row={{ ...card.total, name: totalName }} measures={card.measures} openGapsShown={card.openGapsShown} threshold={card.smallNumberThreshold} panel={card.panel.requested} kind="total" />
                </tbody>
              </table>
            </ScrollRegion>
            <div className="space-y-3 md:hidden print:hidden" data-testid="scorecard-cards">
              {[
                ...shown.locations.flatMap((l) => [
                  ...l.providers.map((row) => ({ row, kind: "provider" as const })),
                  { row: { ...l.subtotal, name: `${l.location} subtotal` }, kind: "subtotal" as const },
                ]),
                ...(shown.other ? [{ row: shown.other, kind: "other" as const }] : []),
                { row: { ...card.total, name: totalName }, kind: "total" as const },
              ].map(({ row, kind }) => (
                <article key={row.providerId ?? `${kind}-${row.name}`} data-testid={`scorecard-card-${kind}`} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                  <h3 className="font-medium">{row.name}</h3>
                  <dl className="mt-2 space-y-2 text-sm">
                    {card.measures.map((m) => (
                      <div key={m.measureId} className="flex items-start justify-between gap-3">
                        <dt className="text-neutral-600 dark:text-neutral-400" title={header(m).title}>{header(m).label}</dt>
                        <dd className="text-right">
                          <CellBody
                            cell={row.cells[m.measureId]}
                            measure={m}
                            gapHref={gapHref(kind, row.providerId, m.measureId, card.panel.requested)}
                            openGapsShown={card.openGapsShown}
                            threshold={card.smallNumberThreshold}
                          />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </div>
          </>
        )
      ) : null}
    </section>
  );
}

function LocationRows({
  location,
  measures,
  openGapsShown,
  threshold,
  panel,
}: {
  location: Scorecard["locations"][number];
  measures: ScorecardMeasure[];
  openGapsShown: boolean;
  threshold: number;
  panel: "me" | "all";
}) {
  return (
    <>
      <tr className="border-t border-neutral-200 bg-neutral-50/60 dark:border-neutral-800 dark:bg-neutral-900/30">
        <th scope="rowgroup" colSpan={measures.length + 1} className="sticky left-0 px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
          {location.location}
        </th>
      </tr>
      {location.providers.map((p) => (
        <Row key={p.providerId} row={p} measures={measures} openGapsShown={openGapsShown} threshold={threshold} panel={panel} kind="provider" />
      ))}
      <Row row={{ ...location.subtotal, name: `${location.location} subtotal` }} measures={measures} openGapsShown={openGapsShown} threshold={threshold} panel={panel} kind="subtotal" />
    </>
  );
}

function Row({
  row,
  measures,
  openGapsShown,
  threshold,
  panel,
  kind,
}: {
  row: ScorecardRow;
  measures: ScorecardMeasure[];
  openGapsShown: boolean;
  threshold: number;
  panel: "me" | "all";
  kind: RowKind;
}) {
  const strong = kind === "subtotal" || kind === "total";
  return (
    <tr data-testid={`scorecard-row-${kind}`} className={`border-t border-neutral-200 dark:border-neutral-800 ${kind === "total" ? "border-t-2" : ""}`}>
      <th scope="row" className={`sticky left-0 z-10 bg-white px-3 py-2 text-left dark:bg-neutral-950 ${strong ? "font-semibold" : "font-normal"}`}>
        {row.name}
      </th>
      {measures.map((m) => (
        <td key={m.measureId} className="px-3 py-2 align-top">
          <CellBody
            cell={row.cells[m.measureId]}
            measure={m}
            gapHref={gapHref(kind, row.providerId, m.measureId, panel)}
            openGapsShown={openGapsShown}
            threshold={threshold}
          />
        </td>
      ))}
    </tr>
  );
}

type RowKind = "provider" | "subtotal" | "other" | "total";

/**
 * Where a cell's "N open" goes: the work list on exactly the patients the count is over. A provider's
 * opens that provider's; the total opens the whole practice, or the caller's panel under "My providers"
 * (the same set). A location's and Other's have no work-list filter that lands on exactly them, so they
 * are text.
 */
function gapHref(kind: RowKind, providerId: string | null, measureId: string, panel: "me" | "all"): string | null {
  if (kind === "provider" && providerId) return worklistHref({ measureId, providerId, wholePractice: true });
  if (kind === "total") return panel === "me" ? worklistHref({ measureId, myPanel: true }) : worklistHref({ measureId, wholePractice: true });
  return null;
}

function CellBody({
  cell,
  measure,
  gapHref: href,
  openGapsShown,
  threshold,
}: {
  cell: ScorecardCell | undefined;
  measure: ScorecardMeasure;
  gapHref: string | null;
  openGapsShown: boolean;
  threshold: number;
}) {
  const gaps = cell?.openGaps ?? null;
  return (
    <div className="space-y-1">
      {cell?.rates ? (
        cell.rates.map((r, i) => (
          <div key={r.label ?? i} className={r.smallNumber ? "text-neutral-400 dark:text-neutral-500" : undefined}>
            {r.label ? <span className="mr-1 text-[10px] uppercase text-neutral-500">{r.label}</span> : null}
            <span className="font-medium">{pct(r.score)}</span>{" "}
            <span className="text-xs">({r.numer} / {r.effectiveDenominator})</span>
            {r.smallNumber && r.effectiveDenominator > 0 ? (
              <span className="block text-[10px]">fewer than {threshold} {SUBJECT.plural}</span>
            ) : null}
          </div>
        ))
      ) : (
        <span className="text-neutral-400" title={measure.state !== "complete" ? REFUSED[measure.state] : undefined}>—</span>
      )}
      {openGapsShown && gaps !== null && gaps > 0 ? (
        href ? (
          <Link href={href} className="block text-xs text-blue-600 hover:underline dark:text-blue-400">
            {gaps} open
          </Link>
        ) : (
          <span className="block text-xs text-neutral-500">{gaps} open</span>
        )
      ) : null}
    </div>
  );
}
