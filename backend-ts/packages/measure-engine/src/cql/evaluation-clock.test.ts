/**
 * The authored engine's measurement period and evaluation time do not depend on the host's time zone (#845).
 *
 * The check runs in a child process with `TZ=Asia/Tokyo` and NO process pin, because this package is
 * published and must not rely on its caller having pinned the process. The control line proves the child
 * really is at +9: an offset-less DateTime there takes the host's offset, which is the bug this replaced.
 *
 *   node --import tsx --test packages/measure-engine/src/cql/evaluation-clock.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

test("#845: the period and the evaluation time are stated at offset 0, even on a +9 host", () => {
  const source = `
    import cql from "cql-execution";
    import { evaluationClock } from "./cql-execution-engine.ts";
    const { measurementPeriod, executionDateTime } = evaluationClock("2026-06-30", 12);
    console.log(JSON.stringify({
      control: cql.DateTime.parse("2026-06-30T00:00:00.0").timezoneOffset,
      low: measurementPeriod.low.toString(),
      high: measurementPeriod.high.toString(),
      now: executionDateTime.toString(),
      offsets: [measurementPeriod.low.timezoneOffset, measurementPeriod.high.timezoneOffset, executionDateTime.timezoneOffset],
    }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: here,
    env: { ...process.env, TZ: "Asia/Tokyo" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
  assert.equal(out.control, 9, "control: the child must really be at +9, or this test proves nothing");
  assert.deepEqual(out.offsets, [0, 0, 0]);
  assert.equal(out.low, "2025-06-30T00:00:00.000+00:00", "a 12-month look-back starts a year before the evaluation date");
  assert.equal(out.high, "2026-06-30T23:59:59.000+00:00");
  assert.equal(out.now, "2026-06-30T00:00:00.000+00:00");
});
