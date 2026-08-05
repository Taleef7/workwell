/**
 * Which cql-tests capabilities WorkWell claims — i.e. what may legitimately be skipped.
 *
 * ## The corpus's own mechanism, used instead of a SkipList
 *
 * `<capability code="…"/>` appears at file, group and test level, and is how `cql-tests` expects a runner
 * to declare what it does not implement. Issue #296 proposed "a documented SkipList (known upstream
 * clusters: Long type, LowBoundary/HighBoundary, decimal precision, Quantity mod/div, interval Expand)".
 * A list of test NAMES rots — cases get renamed, added and regrouped upstream, and a stale entry silently
 * stops skipping (or silently skips a case that now passes). The capability set is the corpus's own
 * vocabulary, so it survives that churn.
 *
 * ## Why the unclaimed set is EMPTY, deliberately
 *
 * The point of this harness is to MEASURE the delta between our JS translator and the Java translator the
 * published `cql-execution` 3.3.x results were produced with. Skipping the known-weak clusters would
 * delete exactly the finding we are here to publish: `system.long` (33 tests) is the clearest example —
 * if `@cqframework/cql` cannot translate `1L`, that is a `translation-error` worth reporting, not a
 * capability to disclaim.
 *
 * So we claim everything and let failures be failures. `skipped` is 0 today, and every case lands in a
 * graded bucket. That is a stronger position than a good pass rate over a reduced denominator.
 *
 * ## When to add an entry
 *
 * Only for a capability we have decided not to implement — with the reason written down, in a PR that says
 * so. Never to make a red number go away: a failing test is information, and this file is not the place to
 * discard it. Anything added here appears in the report with its reason attached, and the run summary
 * states the skipped count next to the total so a shrinking denominator is visible rather than implied.
 */

/**
 * Capability codes we do NOT claim. Empty by design — see above.
 *
 * Shape kept as `Map<code, reason>` rather than a `Set` so that adding an entry forces writing the reason
 * at the same moment, and the reason reaches the report rather than living in a comment.
 */
export const UNCLAIMED_CAPABILITIES: ReadonlyMap<string, string> = new Map<string, string>([
  // Intentionally empty. Example of the shape an entry would take:
  //   ["system.long", "…the reason, and the PR that decided it"],
]);

export interface SkipDecision {
  skip: boolean;
  /** The first unclaimed capability the case requires, and why we do not claim it. */
  capability?: string;
  reason?: string;
}

/**
 * Decide whether a case is skipped, given the capability codes it requires (its own, merged with its
 * group's and its file's — `parseTestFile` does that merge).
 */
/**
 * `unclaimed` is injectable so a test can drive THIS function against a populated map. The first cut
 * re-implemented the loop inside the test to prove "it is the map that is empty, not the code" — which
 * tested a copy and could not have caught a bug here (review, #398). That is the codebase's own
 * vacuous-guard shape, in the test written to argue against it.
 */
export function skipDecision(
  required: readonly string[],
  unclaimed: ReadonlyMap<string, string> = UNCLAIMED_CAPABILITIES,
): SkipDecision {
  for (const code of required) {
    const reason = unclaimed.get(code);
    if (reason !== undefined) return { skip: true, capability: code, reason };
  }
  return { skip: false };
}
