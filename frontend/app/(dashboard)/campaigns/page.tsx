"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/api/hooks";

// ── Backend contract (issue #75 E5 — outreach at scale) ────────────────────────
type ProgramSummary = {
  measureId: string;
  measureName: string;
};

type CampaignRecipient = {
  caseId: string;
  employeeId: string;
  employeeName: string;
  channel: string;
  toAddress: string;
  status: string;
  messageId: string | null;
  sentAt: string | null;
};

type CampaignResult = {
  campaignId: string | null;
  channel: string;
  dryRun: boolean;
  total: number;
  sent: number;
  failed: number;
  simulated: number;
  recipients: CampaignRecipient[];
};

type CampaignRecord = {
  id: string;
  channel: string;
  measureId: string | null;
  site: string | null;
  outcomeStatus: string | null;
  templateId: string | null;
  status: string;
  total: number;
  sent: number;
  failed: number;
  simulated: number;
  createdBy: string | null;
  createdAt: string;
};

type CampaignDetail = {
  campaign: CampaignRecord;
  recipients: CampaignRecipient[];
};

type LaunchBody = {
  measureId?: string;
  site?: string;
  outcomeStatus?: string;
  channel: string;
  templateId?: string;
  dryRun?: boolean;
};

const CHANNEL_OPTIONS = ["EMAIL", "SMS", "PHONE"] as const;
const OUTCOME_OPTIONS = ["OVERDUE", "MISSING_DATA", "DUE_SOON"] as const;

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function CampaignsPage() {
  const api = useApi();

  // Filter sources (shared with /programs).
  const [measures, setMeasures] = useState<ProgramSummary[]>([]);
  const [sites, setSites] = useState<string[]>([]);

  // Launcher form state.
  const [measureId, setMeasureId] = useState("");
  const [site, setSite] = useState("");
  const [outcomeStatus, setOutcomeStatus] = useState("");
  const [channel, setChannel] = useState<string>("EMAIL");

  // Launch result + loading/error state.
  const [result, setResult] = useState<CampaignResult | null>(null);
  const [launching, setLaunching] = useState<"dry" | "send" | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // History state.
  const [history, setHistory] = useState<CampaignRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Selected campaign detail.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const measureNameById = useMemo(() => {
    const map = new Map<string, string>();
    measures.forEach((m) => map.set(m.measureId, m.measureName));
    return map;
  }, [measures]);

  // Measure + site dropdowns are sourced the same way /programs sources them.
  useEffect(() => {
    let cancelled = false;
    api
      .get<ProgramSummary[]>("/api/programs/overview")
      .then((data) => {
        if (!cancelled) setMeasures(data);
      })
      .catch(() => {
        if (!cancelled) setMeasures([]);
      });
    api
      .get<string[]>("/api/programs/sites")
      .then((data) => {
        if (!cancelled) setSites(data);
      })
      .catch(() => {
        if (!cancelled) setSites([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await api.get<CampaignRecord[]>("/api/campaigns");
      setHistory(data);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Unknown error");
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [api]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadHistory();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadHistory]);

  function buildBody(dryRun: boolean): LaunchBody {
    const body: LaunchBody = { channel, dryRun };
    if (measureId) body.measureId = measureId;
    if (site) body.site = site;
    if (outcomeStatus) body.outcomeStatus = outcomeStatus;
    return body;
  }

  async function launch(dryRun: boolean) {
    setLaunching(dryRun ? "dry" : "send");
    setLaunchError(null);
    try {
      const data = await api.post<LaunchBody, CampaignResult>("/api/campaigns", buildBody(dryRun));
      setResult(data);
      if (!dryRun) {
        // A real send creates a history record — refresh the list.
        await loadHistory();
      }
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : "Unknown error");
      setResult(null);
    } finally {
      setLaunching(null);
    }
  }

  const loadDetail = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setDetailLoading(true);
      setDetailError(null);
      setDetail(null);
      try {
        const data = await api.get<CampaignDetail>(`/api/campaigns/${id}`);
        setDetail(data);
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : "Unknown error");
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [api],
  );

  const selectClass =
    "rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";
  const labelClass = "text-xs uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400";

  function measureLabel(id: string | null): string {
    if (!id) return "All measures";
    return measureNameById.get(id) ?? id;
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Outreach Campaigns</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Launch outreach across a measure, site, or outcome cohort in one action.
        </p>
      </div>

      {/* ── Launcher ─────────────────────────────────────────────── */}
      <div className="rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-neutral-500 dark:text-neutral-400">
          New campaign
        </h3>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="campaign-measure" className={labelClass}>
              Measure
            </label>
            <select
              id="campaign-measure"
              value={measureId}
              onChange={(e) => setMeasureId(e.target.value)}
              className={selectClass}
            >
              <option value="">All measures</option>
              {measures.map((m) => (
                <option key={m.measureId} value={m.measureId}>
                  {m.measureName}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="campaign-site" className={labelClass}>
              Site
            </label>
            <select id="campaign-site" value={site} onChange={(e) => setSite(e.target.value)} className={selectClass}>
              <option value="">All sites</option>
              {sites.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="campaign-outcome" className={labelClass}>
              Outcome
            </label>
            <select
              id="campaign-outcome"
              value={outcomeStatus}
              onChange={(e) => setOutcomeStatus(e.target.value)}
              className={selectClass}
            >
              <option value="">All</option>
              {OUTCOME_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="campaign-channel" className={labelClass}>
              Channel
            </label>
            <select
              id="campaign-channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className={selectClass}
            >
              {CHANNEL_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="campaign-template" className={labelClass}>
              Template
            </label>
            <select id="campaign-template" value="" disabled className={`${selectClass} opacity-70`}>
              <option value="">Default (outcome-based)</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void launch(true)}
              disabled={launching !== null}
              className="rounded-md border border-neutral-300 bg-white px-4 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              {launching === "dry" ? "Previewing…" : "Dry run"}
            </button>
            <button
              type="button"
              onClick={() => void launch(false)}
              disabled={launching !== null}
              className="rounded-md bg-primary-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {launching === "send" ? "Sending…" : "Send campaign"}
            </button>
          </div>
        </div>

        <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
          Sends are simulated on the demo stack.
        </p>

        {launchError ? (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {launchError}
          </p>
        ) : null}

        {/* ── Launch result ──────────────────────────────────────── */}
        {result ? (
          <div className="mt-4 space-y-3">
            {result.dryRun ? (
              <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Dry run preview — {result.total} recipient{result.total === 1 ? "" : "s"} ({result.channel}). No messages
                sent.
              </p>
            ) : (
              <div className="flex flex-wrap gap-4 text-sm">
                <span className="text-neutral-700 dark:text-neutral-300">
                  Channel: <span className="font-semibold">{result.channel}</span>
                </span>
                <span className="text-neutral-700 dark:text-neutral-300">
                  Total: <span className="font-semibold">{result.total}</span>
                </span>
                <span className="text-neutral-700 dark:text-neutral-300">
                  Sent: <span className="font-semibold">{result.sent}</span>
                </span>
                <span className="text-neutral-700 dark:text-neutral-300">
                  Failed: <span className="font-semibold">{result.failed}</span>
                </span>
                <span className="text-neutral-700 dark:text-neutral-300">
                  Simulated: <span className="font-semibold">{result.simulated}</span>
                </span>
              </div>
            )}

            {result.recipients.length > 0 ? (
              <RecipientTable recipients={result.recipients} />
            ) : (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">No matching recipients for this scope.</p>
            )}
          </div>
        ) : null}
      </div>

      {/* ── History ──────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-neutral-500 dark:text-neutral-400">
          Campaign history
        </h3>

        {historyError ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            Failed to load campaigns: {historyError}
          </p>
        ) : null}

        {historyLoading ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading…</p>
        ) : history.length === 0 && !historyError ? (
          <div className="rounded-md border border-dashed border-neutral-300 bg-white p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
            No campaigns yet. Launch one above.
          </div>
        ) : history.length > 0 ? (
          <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-[0.1em] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                  <th className="px-4 py-2 font-semibold">Created</th>
                  <th className="px-4 py-2 font-semibold">Channel</th>
                  <th className="px-4 py-2 font-semibold">Measure</th>
                  <th className="px-4 py-2 text-right font-semibold">Total</th>
                  <th className="px-4 py-2 text-right font-semibold">Sent</th>
                  <th className="px-4 py-2 text-right font-semibold">Failed</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => void loadDetail(c.id)}
                    className={`cursor-pointer border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50 ${
                      selectedId === c.id ? "bg-neutral-50 dark:bg-neutral-800/50" : ""
                    }`}
                  >
                    <td className="px-4 py-2 text-neutral-700 dark:text-neutral-300">{formatDateTime(c.createdAt)}</td>
                    <td className="px-4 py-2 text-neutral-700 dark:text-neutral-300">{c.channel}</td>
                    <td className="px-4 py-2 text-neutral-900 dark:text-neutral-100">{measureLabel(c.measureId)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-700 dark:text-neutral-300">{c.total}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-700 dark:text-neutral-300">{c.sent}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-700 dark:text-neutral-300">{c.failed}</td>
                    <td className="px-4 py-2 text-neutral-700 dark:text-neutral-300">{c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* ── Selected campaign detail ───────────────────────────── */}
        {selectedId ? (
          <div className="rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
            <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Recipients</h4>
            {detailLoading ? (
              <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">Loading…</p>
            ) : detailError ? (
              <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                {detailError}
              </p>
            ) : detail && detail.recipients.length > 0 ? (
              <div className="mt-3">
                <RecipientTable recipients={detail.recipients} />
              </div>
            ) : (
              <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">No recipients on this campaign.</p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function RecipientTable({ recipients }: { recipients: CampaignRecipient[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-[0.1em] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            <th className="px-4 py-2 font-semibold">Employee</th>
            <th className="px-4 py-2 font-semibold">Channel</th>
            <th className="px-4 py-2 font-semibold">To</th>
            <th className="px-4 py-2 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {recipients.map((r) => (
            <tr
              key={r.caseId}
              className="border-b border-neutral-100 last:border-b-0 dark:border-neutral-800"
            >
              <td className="px-4 py-2 text-neutral-900 dark:text-neutral-100">{r.employeeName}</td>
              <td className="px-4 py-2 text-neutral-700 dark:text-neutral-300">{r.channel}</td>
              <td className="px-4 py-2 text-neutral-700 dark:text-neutral-300">{r.toAddress}</td>
              <td className="px-4 py-2 text-neutral-700 dark:text-neutral-300">{r.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
