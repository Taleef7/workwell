/**
 * The compaction pass writes OUTCOMES_COMPACTION_STARTED BEFORE it deletes (outcome-compaction.ts) and
 * that write is awaited, so its absence means no pass ran and its `cutoff` bounds what a pass could
 * have reached. That is the only completeness evidence that is not derived from the surviving rows.
 *   node --import tsx --test src/run/compaction-evidence.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactionExposure } from "./compaction-evidence.ts";

const events = (cutoffs: string[]) => ({
  recentAuditEventsByType: async (_type: string, limit: number) =>
    cutoffs.slice(0, limit).map((cutoff) => ({
      occurredAt: cutoff, eventType: "OUTCOMES_COMPACTION_STARTED", actor: "system",
      refRunId: null, refCaseId: null, refMeasureVersionId: null, payload: { cutoff, retentionDays: 400 },
    })),
});

test("no compaction pass ever ran → not exposed", async () => {
  assert.deepEqual(await compactionExposure({ startedAt: "2026-01-01T00:00:00.000Z" }, events([])), { exposed: false, cutoff: null });
});

test("a pass whose cutoff postdates the run's start → exposed, naming the cutoff", async () => {
  assert.deepEqual(
    await compactionExposure({ startedAt: "2026-01-01T00:00:00.000Z" }, events(["2026-06-01T00:00:00.000Z"])),
    { exposed: true, cutoff: "2026-06-01T00:00:00.000Z" },
  );
});

test("a pass whose cutoff predates the run's start could not have reached it → not exposed", async () => {
  assert.deepEqual(
    await compactionExposure({ startedAt: "2026-07-01T00:00:00.000Z" }, events(["2026-06-01T00:00:00.000Z"])),
    { exposed: false, cutoff: "2026-06-01T00:00:00.000Z" },
  );
});

test("the FURTHEST cutoff counts, not the newest: widening the window moves the next cutoff backwards", async () => {
  // Events are newest-first: the newest pass (730-day window) has an EARLIER cutoff than the one before
  // it (400-day window). A run that started between the two was reachable by the earlier pass.
  const exposure = await compactionExposure(
    { startedAt: "2026-05-01T00:00:00.000Z" },
    events(["2026-03-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"]),
  );
  assert.deepEqual(exposure, { exposed: true, cutoff: "2026-06-01T00:00:00.000Z" });
});

test("a malformed intent payload is treated as exposure, never as proof of completeness", async () => {
  const bad = {
    recentAuditEventsByType: async () => [
      { occurredAt: "x", eventType: "OUTCOMES_COMPACTION_STARTED", actor: "system", refRunId: null, refCaseId: null, refMeasureVersionId: null, payload: {} },
    ],
  };
  assert.deepEqual(await compactionExposure({ startedAt: "2026-07-01T00:00:00.000Z" }, bad), { exposed: true, cutoff: null });
  // One unreadable pass among readable ones still means exposure, while the readable maximum is reported.
  const mixed = {
    recentAuditEventsByType: async () => [
      { occurredAt: "x", eventType: "OUTCOMES_COMPACTION_STARTED", actor: "system", refRunId: null, refCaseId: null, refMeasureVersionId: null, payload: {} },
      { occurredAt: "y", eventType: "OUTCOMES_COMPACTION_STARTED", actor: "system", refRunId: null, refCaseId: null, refMeasureVersionId: null, payload: { cutoff: "2026-01-01T00:00:00.000Z" } },
    ],
  };
  assert.deepEqual(await compactionExposure({ startedAt: "2026-07-01T00:00:00.000Z" }, mixed), { exposed: true, cutoff: "2026-01-01T00:00:00.000Z" });
});
