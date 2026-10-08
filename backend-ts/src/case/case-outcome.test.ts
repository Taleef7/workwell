/**
 * The one row a case cites (#769): with the case's period, the subject's row OF THAT PERIOD in the cited
 * run, even when another year's row was written first; without it, the first row, read with `limit: 1`.
 *   node --import tsx --test src/case/case-outcome.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { citedRow, outcomeForCase } from "./case-outcome.ts";
import type { OutcomeRecord, OutcomeStore } from "../stores/outcome-store.ts";

const row = (id: string, subjectId: string, evaluationPeriod: string, evaluatedAt: string): OutcomeRecord => ({
  id, runId: "r1", subjectId, measureId: "cms137", evaluationPeriod, status: "OVERDUE", evidence: { id }, evaluatedAt,
});

/** The store's contract: filtered, ordered `evaluated_at ASC, id ASC`, `limit` applied after. Records each call. */
function fakeStore(rows: OutcomeRecord[]) {
  const calls: Array<Parameters<OutcomeStore["listOutcomes"]>[1]> = [];
  const store: Pick<OutcomeStore, "listOutcomes"> = {
    async listOutcomes(runId, opts) {
      calls.push(opts);
      const out = rows
        .filter((r) => r.runId === runId && (!opts?.subjectId || r.subjectId === opts.subjectId) && (!opts?.measureId || r.measureId === opts.measureId))
        .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.id.localeCompare(b.id));
      return opts?.limit != null ? out.slice(0, opts.limit) : out;
    },
  };
  return { store, calls };
}

// One /evaluate run holding p1's 2026 row (written first) and 2027 row; p2's only row predates the column.
const ROWS = [
  row("o-2027", "p1", "2027", "2026-10-01T00:00:05Z"),
  row("o-2026", "p1", "2026", "2026-10-01T00:00:00Z"),
  row("o-legacy", "p2", "", "2026-10-01T00:00:00Z"),
];

test("with the case's period, the row of that period wins, whichever was written first", async () => {
  const { store } = fakeStore(ROWS);
  assert.equal((await outcomeForCase(store, "r1", "p1", "cms137", "2027"))?.id, "o-2027");
  assert.equal((await outcomeForCase(store, "r1", "p1", "cms137", "2026"))?.id, "o-2026");
});

test("no row of the case's period (a legacy '' row, or another year only): the first row stands", async () => {
  const { store } = fakeStore(ROWS);
  assert.equal((await outcomeForCase(store, "r1", "p2", "cms137", "2026"))?.id, "o-legacy");
  assert.equal((await outcomeForCase(store, "r1", "p1", "cms137", "2025"))?.id, "o-2026");
  assert.equal(await outcomeForCase(store, "r1", "p9", "cms137", "2026"), null);
});

test("without a period: exactly the old read — one row, `limit: 1`, the first in evaluated order", async () => {
  const { store, calls } = fakeStore(ROWS);
  assert.equal((await outcomeForCase(store, "r1", "p1", "cms137"))?.id, "o-2026");
  assert.equal((await outcomeForCase(store, "r1", "p1", "cms137", ""))?.id, "o-2026");
  assert.deepEqual(calls, [
    { subjectId: "p1", measureId: "cms137", limit: 1 },
    { subjectId: "p1", measureId: "cms137", limit: 1 },
  ]);
});

test("citedRow: the first row of the period, else the first row, else null", () => {
  const rows = [{ evaluationPeriod: "2026", n: 1 }, { evaluationPeriod: "2027", n: 2 }, { evaluationPeriod: "2027", n: 3 }];
  assert.equal(citedRow(rows, "2027")?.n, 2);
  assert.equal(citedRow(rows, "2028")?.n, 1);
  assert.equal(citedRow(rows, null)?.n, 1);
  assert.equal(citedRow([], "2027"), null);
});
