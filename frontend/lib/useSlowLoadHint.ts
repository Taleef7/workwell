"use client";

import { useEffect, useState } from "react";
import { SUBJECT } from "@/lib/terminology";

/**
 * UX-3 — the honest "this is working, not broken" copy shown once an in-flight load has run for 3s
 * (the hierarchy rollup and the roster's cold hit both can). It names no row count and no deployment,
 * because the same copy is shown on every instance and a number that is true for one is false for the
 * next; the subject noun follows the deployment profile ("employee" on TWH, "patient" on the pilot).
 * Config-light constant (no i18n plumbing).
 */
export const SLOW_LOAD_HINT = `Still working — reading the latest results for every ${SUBJECT.singular} on the roster…`;

/**
 * Returns true once an in-flight load has been running longer than `delayMs` (default 3s), and false
 * again the instant it resolves. Pages use this to swap a bare skeleton for {@link SLOW_LOAD_HINT}
 * (and to extend their existing aria-live announcement) so a long wait reads as progress, not a bug.
 * A load that finishes before the delay never flips the hint on.
 */
export function useSlowLoadHint(loading: boolean, delayMs = 3000): boolean {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    // Not loading → clear the hint. Deferred to a 0-timeout (not a synchronous setState in the effect
    // body) to satisfy react-hooks/set-state-in-effect, matching the pages' own setTimeout(0) defer.
    if (!loading) {
      const reset = setTimeout(() => setSlow(false), 0);
      return () => clearTimeout(reset);
    }
    // Loading → the hint only appears if the load is still running at delayMs. slow is already false
    // here (the !loading branch reset it when the prior load ended), so no eager reset is needed.
    const timer = setTimeout(() => setSlow(true), delayMs);
    return () => clearTimeout(timer);
  }, [loading, delayMs]);

  return slow;
}
