/**
 * #263 — IncrementalCache unit tests for the review-fix behaviors, with in-memory fakes (no engine/DB):
 *   - logic_version reflects the ENGINE-SELECTED library + value-set expansion hashes (review #3 / Codex
 *     P1): toggling expansion active, or changing a referenced value set's expansion_hash, invalidates
 *     reuse for a measure that expands; the scoped/demo path (no expansion) is unaffected.
 *   - the backdated-reuse gate (review #1) is covered end-to-end in parity.test.ts.
 *   node --import tsx --test src/run/incremental/incremental-eval.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { IncrementalCache, type IncrementalDeps } from "./incremental-eval.ts";
import type { EvalStateStore, EvalStateRow, UpsertEvalStateInput } from "../../stores/eval-state-store.ts";
import type { OutcomeRecord } from "../../stores/outcome-store.ts";

/** In-memory EvalStateStore keyed subject|measure|period. */
class FakeEvalState implements EvalStateStore {
  rows = new Map<string, EvalStateRow>();
  private k = (s: string, m: string, p: string) => `${s}|${m}|${p}`;
  async getEvalState(s: string, m: string, p: string) { return this.rows.get(this.k(s, m, p)) ?? null; }
  async listEvalStatesForMeasurePeriod(m: string, p: string) {
    return [...this.rows.values()].filter((r) => r.measureId === m && r.period === p);
  }
  async upsertEvalState(input: UpsertEvalStateInput) {
    this.rows.set(this.k(input.subjectId, input.measureId, input.period), { id: "x", ...input });
  }
}
const fakeOutcomes = (evidence: unknown): Pick<import("../../stores/outcome-store.ts").OutcomeStore, "getOutcomeById"> => ({
  async getOutcomeById(): Promise<OutcomeRecord | null> {
    return { id: "o1", runId: "r1", subjectId: "s1", measureId: "audiogram", evaluationPeriod: "2026-01-01", status: "OVERDUE", evidence, evaluatedAt: "2026-06-15T00:00:00.000Z" };
  },
});

const PERIOD = "2026-01-01";
const bundle = { resourceType: "Bundle", type: "collection", entry: [{ resource: { resourceType: "Patient", id: "s1" } }] };

function cache(evalState: FakeEvalState, over: Partial<IncrementalDeps> = {}): IncrementalCache {
  return new IncrementalCache({ evalState, outcomes: fakeOutcomes({ expressionResults: [] }), evalDate: "2026-06-15", ...over });
}

/** Commit a fingerprint for (s1, audiogram) under the given deps, so a later plan can hit/miss it. */
async function seed(evalState: FakeEvalState, over: Partial<IncrementalDeps>): Promise<void> {
  const c = cache(evalState, over);
  const plan = await c.plan("audiogram", "s1", PERIOD, bundle);
  assert.equal(plan.action, "evaluate"); // first time is always a miss
  // OVERDUE ⇒ terminal (next_transition_at null), so a same-config replan would reuse.
  await c.commit("audiogram", "s1", PERIOD, "OVERDUE", "o1", { expressionResults: [] }, plan as { dataHash: string; logicVersion: string });
}

test("same config ⇒ reuse (control): a terminal row replans as a hit", async () => {
  const es = new FakeEvalState();
  await seed(es, { expansionActive: false });
  const plan = await cache(es, { expansionActive: false }).plan("audiogram", "s1", PERIOD, bundle);
  assert.equal(plan.action, "reuse");
});

test("toggling expansion active invalidates reuse for a measure with an expansion library (audiogram)", async () => {
  const es = new FakeEvalState();
  await seed(es, { expansionActive: false }); // committed with the BASE library's logic_version
  // Same bundle/date, but now the engine would execute the expansion library ⇒ different logic_version.
  const plan = await cache(es, { expansionActive: true }).plan("audiogram", "s1", PERIOD, bundle);
  assert.equal(plan.action, "evaluate", "expansion toggle ⇒ logic_version mismatch ⇒ re-evaluate");
});

test("changing a referenced value set's expansion_hash invalidates reuse (VSAC re-import / operator edit)", async () => {
  const es = new FakeEvalState();
  const withHash = (h: string): Partial<IncrementalDeps> => ({
    expansionActive: true,
    valueSetExpansionHashes: new Map([["urn:workwell:vs:audiogram-procedures", h]]),
  });
  await seed(es, withHash("sha256:h1"));
  const plan = await cache(es, withHash("sha256:h2")).plan("audiogram", "s1", PERIOD, bundle);
  assert.equal(plan.action, "evaluate", "expansion_hash change ⇒ logic_version mismatch ⇒ re-evaluate");
  // And the SAME hash still reuses (not always-miss).
  const es2 = new FakeEvalState();
  await seed(es2, withHash("sha256:h1"));
  assert.equal((await cache(es2, withHash("sha256:h1")).plan("audiogram", "s1", PERIOD, bundle)).action, "reuse");
});

test("scoped/demo path is unaffected: no expansion ⇒ value-set map is ignored", async () => {
  const es = new FakeEvalState();
  await seed(es, { expansionActive: false });
  // A stray value-set map with expansionActive off must not change the logic_version (base library only).
  const plan = await cache(es, { expansionActive: false, valueSetExpansionHashes: new Map([["urn:workwell:vs:audiogram-procedures", "sha256:zzz"]]) })
    .plan("audiogram", "s1", PERIOD, bundle);
  assert.equal(plan.action, "reuse", "no expansion ⇒ hashes not folded ⇒ still a hit");
});
