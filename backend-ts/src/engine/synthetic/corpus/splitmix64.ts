/**
 * SplitMix64 (Vigna) — the corpus PRNG. In-repo and dependency-free on purpose: the corpus must be
 * byte-reproducible from (seed, index) for the life of the pilot, which a third-party PRNG whose
 * implementation may change across a major version cannot promise.
 *
 * Every patient draws from their OWN stream, keyed by (seed, index), so generation order and batch
 * boundaries never change a record (spec §3, "Determinism").
 */
import { createHash } from "node:crypto";

const MASK = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;

export class SplitMix64 {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = seed & MASK;
  }

  /** One 64-bit draw. */
  nextU64(): bigint {
    this.state = (this.state + GOLDEN) & MASK;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return (z ^ (z >> 31n)) & MASK;
  }

  /** Uniform in [0, 1). 53 bits of mantissa, so the conversion is exact. */
  nextFloat(): number {
    return Number(this.nextU64() >> 11n) / 2 ** 53;
  }

  /** Uniform integer in [0, bound). */
  nextInt(bound: number): number {
    if (bound <= 0) throw new Error(`[corpus] nextInt bound must be positive, got ${bound}`);
    return Math.floor(this.nextFloat() * bound);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.nextFloat() < p;
  }

  /** One entry from a weighted table. Weights need not sum to 1; the last entry absorbs rounding. */
  pick<T>(table: readonly (readonly [T, number])[]): T {
    const total = table.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.nextFloat() * total;
    for (const [value, weight] of table) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return table[table.length - 1]![0];
  }

  /** One entry from an unweighted pool. */
  pickOne<T>(pool: readonly T[]): T {
    return pool[this.nextInt(pool.length)]!;
  }
}

/**
 * The per-patient stream key: the first 8 bytes of sha256(seed) as a big-endian BigInt, XOR the index.
 * Hashing the seed means two human-chosen seeds that differ by one character produce unrelated streams.
 */
export function streamKeyFor(seed: string, index: number): bigint {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  const base = digest.readBigUInt64BE(0);
  return (base ^ BigInt(index)) & MASK;
}

/** The stream a patient draws every one of their values from. */
export const streamFor = (seed: string, index: number): SplitMix64 => new SplitMix64(streamKeyFor(seed, index));
