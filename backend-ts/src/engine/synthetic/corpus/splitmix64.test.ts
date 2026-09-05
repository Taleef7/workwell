import test from "node:test";
import assert from "node:assert/strict";
import { SplitMix64, streamKeyFor } from "./splitmix64.ts";

test("SplitMix64 reproduces the reference vectors for seed 0", () => {
  // Reference output of the canonical splitmix64 (Vigna), state advanced by 0x9E3779B97F4A7C15 per draw.
  const rng = new SplitMix64(0n);
  assert.equal(rng.nextU64(), 0xe220a8397b1dcdafn);
  assert.equal(rng.nextU64(), 0x6e789e6aa1b965f4n);
  assert.equal(rng.nextU64(), 0x06c45d188009454fn);
});

test("nextFloat is in [0,1) and nextInt is in range", () => {
  const rng = new SplitMix64(42n);
  for (let i = 0; i < 1000; i += 1) {
    const f = rng.nextFloat();
    assert.ok(f >= 0 && f < 1, `float out of range: ${f}`);
    const n = rng.nextInt(7);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 7, `int out of range: ${n}`);
  }
});

test("pick draws from a weighted table deterministically and covers every entry", () => {
  const table = [["a", 0.5], ["b", 0.3], ["c", 0.2]] as const;
  const first = new SplitMix64(1n);
  const second = new SplitMix64(1n);
  assert.equal(first.pick(table), second.pick(table), "same seed, same draw");
  const seen = new Set<string>();
  const rng = new SplitMix64(9n);
  for (let i = 0; i < 500; i += 1) seen.add(rng.pick(table));
  assert.deepEqual([...seen].sort(), ["a", "b", "c"]);
});

test("streamKeyFor is a pure function of (seed, index) and differs per index", () => {
  assert.equal(streamKeyFor("maui-py2027-v1", 7), streamKeyFor("maui-py2027-v1", 7));
  assert.notEqual(streamKeyFor("maui-py2027-v1", 7), streamKeyFor("maui-py2027-v1", 8));
  assert.notEqual(streamKeyFor("other-seed", 7), streamKeyFor("maui-py2027-v1", 7));
});
