"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { freshnessNotice, type FreshnessNotice, type FreshnessRun, type NightlySchedule } from "./freshness";

// The viewer's own clock, with its zone named, so it cannot be read as UTC or as the practice's zone.
const when = (iso: string): string =>
  new Date(iso).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

export function freshnessMessage(notice: FreshnessNotice): string {
  switch (notice.kind) {
    case "failed":
      // Each card shows its own measure's newest finished run, which a later single-measure run can make
      // newer than any whole-practice update, so this names the last complete update without claiming
      // every card is from it (#710 review).
      return notice.dataFromAt
        ? `The latest update (${when(notice.latestAt)}) did not finish, so the numbers below are from earlier updates. The last complete update of every measure started ${when(notice.dataFromAt)}.`
        : `The latest update (${when(notice.latestAt)}) did not finish, so the numbers below are from earlier updates.`;
    case "partial":
      return `The latest update (${when(notice.latestAt)}) finished with errors for some patients, so some of these numbers may be incomplete.`;
    case "overdue":
      return `No update has run since ${when(notice.latestAt)}, so these numbers may be out of date.`;
    case "none":
      return "No update of every measure has run yet, so the numbers below come only from runs started by hand.";
  }
}

/**
 * Says when the numbers on /programs are not the latest overnight update's (#623). A failed nightly
 * leaves the previous results in place, which is right, and until now said nothing about it. Reads
 * the newest whole-practice runs; stays silent while one is in progress or when all is current, and
 * when the read itself fails (a banner about freshness must not become a second error on the page).
 */
export function RunFreshnessBanner() {
  const api = useApi();
  const [notice, setNotice] = useState<FreshnessNotice | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      // The schedule is optional: without it (an older server, a failed read) the daily rule applies.
      const schedule = api.get<NightlySchedule>("/api/runs/schedule").catch(() => null);
      Promise.all([api.get<FreshnessRun[]>("/api/runs?scopeType=ALL_PROGRAMS&limit=5"), schedule])
        .then(([runs, nightly]) => {
          if (!cancelled) setNotice(Array.isArray(runs) ? freshnessNotice(runs, Date.now(), nightly ?? null) : null);
        })
        .catch(() => {
          if (!cancelled) setNotice(null);
        });
    };
    load();
    // A run finishing (started here or elsewhere) can clear or raise the notice.
    window.addEventListener("ww:run-complete", load);
    return () => {
      cancelled = true;
      window.removeEventListener("ww:run-complete", load);
    };
  }, [api]);

  if (!notice) return null;
  return (
    <div
      role="status"
      data-testid="run-freshness-banner"
      className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
    >
      {freshnessMessage(notice)}
    </div>
  );
}
