/**
 * The memo behind the winners probe. Four properties, each one a way the real thing could go wrong:
 * a hit reads nothing, two concurrent misses read once, a rejection is not cached, and the bound is
 * a bound.
 *   node --import tsx --test src/stores/probe-cache.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProbeCache } from "./probe-cache.ts";

test("a hit does not recompute", async () => {
  const cache = new ProbeCache<number>();
  let calls = 0;
  const compute = async () => ++calls;
  assert.equal(await cache.resolve("k", compute), 1);
  assert.equal(await cache.resolve("k", compute), 1);
  assert.equal(calls, 1);
  assert.equal(await cache.resolve("other", compute), 2, "a different key is a different question");
});

test("two concurrent misses on one key issue ONE read", async () => {
  // The dashboard's shape: the overview request and the detail request land behind one page load, and
  // the second can arrive while the first is still resolving. Caching the VALUE would read twice;
  // caching the PROMISE reads once.
  const cache = new ProbeCache<string>();
  let calls = 0;
  let release: (v: string) => void = () => {};
  const compute = () => {
    calls++;
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  };
  const a = cache.resolve("k", compute);
  const b = cache.resolve("k", compute);
  release("winners");
  assert.deepEqual(await Promise.all([a, b]), ["winners", "winners"]);
  assert.equal(calls, 1);
});

test("a rejection is not cached — the next caller retries", async () => {
  // A statement timeout or a refused connection must not pin "the winners walk fails" for the life of
  // the process, which is exactly what caching the rejected promise would do.
  const cache = new ProbeCache<number>();
  let calls = 0;
  await assert.rejects(
    () =>
      cache.resolve("k", async () => {
        calls++;
        throw new Error("statement timeout");
      }),
    /statement timeout/,
  );
  assert.equal(await cache.resolve("k", async () => 7), 7);
  assert.equal(calls, 1);
  assert.equal(cache.size, 1, "and the failed entry left nothing behind");
});

test("the bound holds, and the eviction victim is never the entry just added", async () => {
  const cache = new ProbeCache<string>(2);
  await cache.resolve("a", async () => "a");
  await cache.resolve("b", async () => "b");
  await cache.resolve("c", async () => "c");
  assert.equal(cache.size, 2);
  let recomputed = false;
  assert.equal(
    await cache.resolve("c", async () => {
      recomputed = true;
      return "c2";
    }),
    "c",
  );
  assert.equal(recomputed, false, "the newest entry survived its own insertion");
  assert.equal(await cache.resolve("a", async () => "a2"), "a2", "the oldest was the one dropped");
});

test("clear drops everything", async () => {
  const cache = new ProbeCache<number>();
  await cache.resolve("k", async () => 1);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(await cache.resolve("k", async () => 2), 2);
});
