"use client";

/**
 * The ACO's attributed patient lists (MM-2 PR 3, ADR-082).
 *
 * The one concrete ask from the 2026-09-09 working session, on its own screen: upload the list of
 * patients the ACO attributes to the group, see what resolved and what did not, and take the
 * measurement year's numbers off it.
 *
 * **The unresolved members are the point of the members table, not an error state.** An identifier
 * the directory cannot resolve is the ACO and the practice disagreeing about who a patient is; that
 * is a finding somebody has to work, so it gets a tab of its own rather than a count in a corner.
 *
 * **The report names a measurement YEAR, with no default.** An officially routed run is scored over
 * its calendar year (ADR-072), so "the latest numbers" would answer a PY2027 question with PY2028's
 * first nightly the moment January arrives — and it would look right. The select is the only way in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Input } from "@mieweb/ui";
import { emitToast } from "@/lib/toast";
import { SUBJECT } from "@/lib/terminology";
import { useApi } from "@/lib/api/hooks";
import { useAuth } from "@/components/auth-provider";
import { canManageCases } from "@/lib/rbac";
import { SkeletonRow } from "@/components/skeleton-loader";
import { useSubjectLists, type SubjectListRow } from "@/features/subject-list/use-subject-lists";

type Resolution = "MATCHED" | "NOT_FOUND" | "AMBIGUOUS";

interface MemberRow {
  rawIdentifier: string;
  subjectId: string | null;
  resolution: Resolution;
  subjectName: string | null;
  providerId: string | null;
  payer: string | null;
}

interface RateGroup {
  label: string | null;
  ipp: number;
  denom: number;
  denex: number;
  denexcep: number;
  numer: number;
  effectiveDenominator: number;
  score: number | null;
}

interface MeasureEntry {
  measureId: string;
  ecqmId: string | null;
  runId: string | null;
  measurementPeriod: { start: string; end: string } | null;
  compactionStatus: "complete" | "compacted" | "no_run";
  reason?: string;
  matchedSubjects: number;
  distinctSubjectsSeen: number;
  missingFromRun: number;
  rates: RateGroup[];
}

interface ReportSummary {
  measurementYear: number;
  generatedAt: string;
  members: { matched: number; notFound: number; ambiguous: number; total: number };
  compactedMeasures: string[];
  measures: MeasureEntry[];
}

const MEMBER_PAGE = 50;
const RESOLUTION_LABEL: Record<Resolution, string> = {
  MATCHED: "Matched",
  NOT_FOUND: "Not found",
  AMBIGUOUS: "Ambiguous",
};

const pct = (score: number | null): string => (score === null ? "—" : `${(score * 100).toFixed(1)}%`);

export default function ListsPage() {
  const api = useApi();
  const { user } = useAuth();
  const mayManage = canManageCases(user?.role);
  const { lists, loading, reload } = useSubjectLists();
  const [selectedId, setSelectedId] = useState<string>("");
  const selected = useMemo(() => lists.find((l) => l.id === selectedId) ?? null, [lists, selectedId]);

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Attributed lists</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          The {SUBJECT.plural} an ACO attributes to this group. A list is immutable — re-uploading the
          same name creates a new revision, so a report filed months ago can still be traced to the
          exact list it was computed over.
        </p>
      </header>

      {mayManage ? <ImportForm onImported={reload} /> : null}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Lists</h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-3">Name</th>
                <th className="p-3">Revision</th>
                <th className="p-3">Matched</th>
                <th className="p-3">Not found</th>
                <th className="p-3">Ambiguous</th>
                <th className="p-3">Imported</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRow cols={7} />
              ) : lists.length === 0 ? (
                <tr>
                  <td className="text-muted-foreground p-4" colSpan={7}>
                    No attributed lists yet.
                  </td>
                </tr>
              ) : (
                lists.map((list) => (
                  <ListRow
                    key={list.id}
                    list={list}
                    selected={list.id === selectedId}
                    onSelect={() => setSelectedId(list.id === selectedId ? "" : list.id)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selected ? (
        <>
          <MembersTable key={`members-${selected.id}`} list={selected} api={api} />
          <ReportPanel key={`report-${selected.id}`} list={selected} api={api} />
        </>
      ) : null}
    </div>
  );
}

function ListRow({
  list,
  selected,
  onSelect,
}: {
  list: SubjectListRow;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <tr className={selected ? "bg-muted/40" : undefined}>
      <td className="p-3 font-medium">
        {list.name}
        {list.source ? <span className="text-muted-foreground block text-xs">{list.source}</span> : null}
      </td>
      <td className="p-3">v{list.revision}</td>
      <td className="p-3">{list.counts.MATCHED.toLocaleString()}</td>
      <td className="p-3">
        {list.counts.NOT_FOUND > 0 ? (
          <Badge variant="outline">{list.counts.NOT_FOUND.toLocaleString()}</Badge>
        ) : (
          list.counts.NOT_FOUND
        )}
      </td>
      <td className="p-3">{list.counts.AMBIGUOUS.toLocaleString()}</td>
      <td className="p-3 text-muted-foreground text-xs">
        {list.createdAt.slice(0, 10)} · {list.createdBy}
      </td>
      <td className="p-3 text-right">
        <Button size="sm" variant={selected ? "secondary" : "outline"} onClick={onSelect}>
          {selected ? "Hide" : "Open"}
        </Button>
      </td>
    </tr>
  );
}

function ImportForm({ onImported }: { onImported: () => Promise<void> }) {
  const api = useApi();
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [identifiers, setIdentifiers] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const lines = identifiers
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!name.trim() || lines.length === 0) {
      emitToast("A name and at least one identifier are required", "error");
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<
        { name: string; source: string | null; identifiers: string[] },
        { counts: { total: number; matched: number; notFound: number; ambiguous: number; duplicatesDropped: number } }
      >("/api/subject-lists", { name: name.trim(), source: source.trim() || null, identifiers: lines });
      emitToast(
        `Imported ${result.counts.matched.toLocaleString()} of ${result.counts.total.toLocaleString()} — ` +
          `${result.counts.notFound.toLocaleString()} not found` +
          (result.counts.duplicatesDropped > 0
            ? `, ${result.counts.duplicatesDropped.toLocaleString()} duplicates dropped`
            : ""),
      );
      setIdentifiers("");
      await onImported();
    } catch (error) {
      // The server's own refusal, verbatim. The sandbox-namespace refusal names a COUNT and never the
      // values, and paraphrasing it here would lose the one number the operator needs.
      emitToast(`Import refused — ${error instanceof Error ? error.message : "unknown error"}`, "error");
    } finally {
      setBusy(false);
    }
  }, [api, identifiers, name, onImported, source]);

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="text-lg font-medium">Import a list</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input placeholder="Name (e.g. ACO Q3 attribution)" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="Source (optional)" value={source} onChange={(e) => setSource(e.target.value)} />
      </div>
      <textarea
        className="bg-background min-h-[8rem] w-full rounded-md border p-2 font-mono text-xs"
        placeholder={`One identifier per line — not a CSV row.\npat-00001\npat-00002`}
        value={identifiers}
        onChange={(e) => setIdentifiers(e.target.value)}
      />
      <p className="text-muted-foreground text-xs">
        This is a synthetic sandbox: an identifier outside its generated directory refuses the whole
        upload, and nothing is written.
      </p>
      <Button onClick={submit} disabled={busy}>
        {busy ? "Importing…" : "Import"}
      </Button>
    </section>
  );
}

function MembersTable({ list, api }: { list: SubjectListRow; api: ReturnType<typeof useApi> }) {
  const [resolution, setResolution] = useState<"" | Resolution>("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<MemberRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // The page resets with the filter, in the CHANGE HANDLER rather than in an effect: a synchronous
  // setState in an effect body is what the lint rule forbids, and the handler is where the decision
  // is actually made. A change of LIST remounts this component (see the `key` at the call site), so
  // there is nothing to reset for that case.

  useEffect(() => {
    let live = true;
    // Deferred, like every other paged fetch here, so the skeleton's setState is not synchronous in
    // the effect body.
    const timer = setTimeout(() => {
      setLoading(true);
      const query = new URLSearchParams({ limit: String(MEMBER_PAGE), offset: String(page * MEMBER_PAGE) });
      if (resolution) query.set("resolution", resolution);
      void api
        .getWithHeaders<MemberRow[]>(`/api/subject-lists/${list.id}/members?${query}`)
        .then(({ data, headers }) => {
          if (!live) return;
          setRows(Array.isArray(data) ? data : []);
          setTotal(Number(headers.get("X-Total-Count") ?? 0) || 0);
        })
        .catch(() => {
          if (live) {
            setRows([]);
            setTotal(0);
          }
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, list.id, page, resolution]);

  const pages = Math.max(1, Math.ceil(total / MEMBER_PAGE));

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-medium">
          Members · {list.name} v{list.revision}
        </h2>
        <select
          aria-label="Resolution"
          className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          value={resolution}
          onChange={(e) => {
            setResolution(e.target.value as "" | Resolution);
            setPage(0);
          }}
        >
          <option value="">All members</option>
          <option value="MATCHED">Matched</option>
          <option value="NOT_FOUND">Not found</option>
          <option value="AMBIGUOUS">Ambiguous</option>
        </select>
        <span className="text-muted-foreground text-sm">{total.toLocaleString()} rows</span>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="p-3">Identifier</th>
              <th className="p-3">Resolution</th>
              <th className="p-3">{SUBJECT.Singular}</th>
              <th className="p-3">PCP</th>
              <th className="p-3">Insurance</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonRow cols={5} />
            ) : rows.length === 0 ? (
              <tr>
                <td className="text-muted-foreground p-4" colSpan={5}>
                  No members match this filter.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.rawIdentifier}>
                  <td className="p-3 font-mono text-xs">{row.rawIdentifier}</td>
                  <td className="p-3">
                    <Badge variant={row.resolution === "MATCHED" ? "secondary" : "outline"}>
                      {RESOLUTION_LABEL[row.resolution]}
                    </Badge>
                  </td>
                  <td className="p-3">{row.subjectName ?? "—"}</td>
                  <td className="p-3">{row.providerId ?? "—"}</td>
                  <td className="p-3">{row.payer ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 ? (
        <div className="flex items-center gap-3 text-sm">
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span>
            Page {page + 1} of {pages}
          </span>
          <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ReportPanel({ list, api }: { list: SubjectListRow; api: ReturnType<typeof useApi> }) {
  const thisYear = new Date().getUTCFullYear();
  // The NEXT year is offered too. The pilot's target is PY2027 while the clock says 2026, and a run
  // can already be created with a 2027 evaluation date — so a list offering only past years would
  // make the one year the pilot exists for unreachable from this page until the clock caught up.
  const years = [thisYear + 1, thisYear, thisYear - 1, thisYear - 2];
  const [year, setYear] = useState(thisYear);
  const [report, setReport] = useState<ReportSummary | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The year the operator is looking at NOW, readable from a continuation that closed over an older
  // one. Written in an effect, not during render — React 19 forbids the latter, and the value only
  // has to be correct by the time an await resumes.
  const yearRef = useRef(year);
  useEffect(() => {
    yearRef.current = year;
  }, [year]);

  const run = useCallback(async () => {
    setBusy(true);
    setRefusal(null);
    const asked = year;
    try {
      const data = await api.get<ReportSummary>(
        `/api/subject-lists/${list.id}/report?measurementYear=${asked}`,
      );
      // Discarded if the operator moved on. Without this an in-flight compute for 2026 could land
      // after they switched to 2027 and repopulate the table under the new selector — the same
      // stale-response shape the roster's request-id guard exists for.
      if (asked !== yearRef.current) return;
      setReport(data);
    } catch (error) {
      // A 409 body is rendered VERBATIM. `run_compacted` means the evidence may be incomplete, and
      // paraphrasing it into "unavailable" would lose the reason a filed number cannot be reproduced.
      if (asked !== yearRef.current) return;
      setReport(null);
      setRefusal(error instanceof Error ? error.message : "unknown error");
    } finally {
      setBusy(false);
    }
  }, [api, list.id, year]);

  const download = useCallback(async () => {
    const blob = await api.downloadBlob(`/api/subject-lists/${list.id}/report?measurementYear=${year}&format=csv`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${list.name.replace(/[^\w.-]+/g, "-")}-v${list.revision}-${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [api, list.id, list.name, list.revision, year]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-medium">Measurement-year report</h2>
        {/* Native, like the roster's page-size control: `@mieweb/ui`'s Select renders a custom combobox
            whose options are not in the DOM, and this one has behaviour worth a test. */}
        <select
          aria-label="Measurement year"
          className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          value={String(year)}
          onChange={(e) => {
            // The shown report and the Download button go with the year they were computed for.
            // Leaving them up let an operator read 2026's table and download 2027's CSV, because
            // `download` reads the CURRENT year — two different years on one screen, neither labelled.
            setYear(Number(e.target.value));
            setReport(null);
            setRefusal(null);
          }}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={run} disabled={busy}>
          {busy ? "Computing…" : "Compute"}
        </Button>
        {report ? (
          <Button size="sm" variant="outline" onClick={download}>
            Download patient-level CSV
          </Button>
        ) : null}
      </div>

      {refusal ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{refusal}</p>
      ) : null}

      {report ? (
        <>
          {report.compactedMeasures.length > 0 ? (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              {report.compactedMeasures.join(", ")} cannot be reported for {report.measurementYear}: the
              run predates a retention cutoff, so a score over the surviving rows would be a different
              number wearing the run&apos;s identity.
            </p>
          ) : null}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-3">Measure</th>
                  <th className="p-3">Rate</th>
                  <th className="p-3">IPP</th>
                  <th className="p-3">Denominator</th>
                  <th className="p-3">Exclusions</th>
                  <th className="p-3">Exceptions</th>
                  <th className="p-3">Numerator</th>
                  <th className="p-3">Score</th>
                  <th className="p-3">Not measured</th>
                </tr>
              </thead>
              <tbody>
                {report.measures.map((measure) =>
                  measure.rates.length === 0 ? (
                    <tr key={measure.measureId}>
                      <td className="p-3 font-medium">{measure.measureId}</td>
                      <td className="text-muted-foreground p-3" colSpan={8}>
                        {measure.compactionStatus === "compacted"
                          ? "Refused — the run predates a retention cutoff"
                          : "No completed population run for this year"}
                      </td>
                    </tr>
                  ) : (
                    measure.rates.map((rate, i) => (
                      <tr key={`${measure.measureId}-${rate.label ?? i}`}>
                        <td className="p-3 font-medium">{i === 0 ? measure.measureId : ""}</td>
                        <td className="p-3">{rate.label ?? "—"}</td>
                        <td className="p-3">{rate.ipp.toLocaleString()}</td>
                        <td className="p-3">{rate.effectiveDenominator.toLocaleString()}</td>
                        <td className="p-3">{rate.denex.toLocaleString()}</td>
                        <td className="p-3">{rate.denexcep.toLocaleString()}</td>
                        <td className="p-3">{rate.numer.toLocaleString()}</td>
                        <td className="p-3 font-medium">{pct(rate.score)}</td>
                        <td className="p-3">{i === 0 ? measure.missingFromRun.toLocaleString() : ""}</td>
                      </tr>
                    ))
                  ),
                )}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground text-xs">
            &ldquo;Not measured&rdquo; counts list members this run never evaluated. They are reported
            beside the rates and never subtracted from a denominator — a smaller run must not produce a
            higher score. The score divides by denominator minus exclusions minus exceptions.
          </p>
        </>
      ) : null}
    </section>
  );
}
