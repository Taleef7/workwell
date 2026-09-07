/**
 * SplitMix64 (Vigna) — the corpus PRNG. In-repo and dependency-free on purpose: the corpus must be
 * byte-reproducible from (seed, index) for the life of the pilot, which a third-party PRNG whose
 * implementation may change across a major version cannot promise.
 *
 * Every patient draws from their OWN stream, keyed by (seed, index), so generation order and batch
 * boundaries never change a record (spec §3, "Determinism").
 */
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
 * The per-patient stream key: a 64-bit FNV-1a digest of the seed, XOR the index.
 *
 * FNV-1a rather than SHA-256 because this module sits on the WORKER REQUEST PATH, which must stay
 * portable — `node:crypto` is unavailable there and the engine-boundary test enforces it. It is also
 * what finally makes this file dependency-free, as its own header always claimed.
 *
 * A cryptographic digest was never needed here: the requirement is that two human-chosen seeds
 * differing by one character produce unrelated streams, which avalanche gives, and FNV-1a avalanches
 * well enough for that. Nothing about corpus identity is a security boundary.
 */
const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;

export function hash64(text: string): bigint {
  let h = FNV_OFFSET;
  // Hash the UTF-8 BYTES, not the UTF-16 code units, so the digest does not depend on how JavaScript
  // happens to represent the string.
  for (const byte of new TextEncoder().encode(text)) {
    h = ((h ^ BigInt(byte)) * FNV_PRIME) & MASK;
  }
  return h;
}

export function streamKeyFor(seed: string, index: number): bigint {
  return (hash64(seed) ^ BigInt(index)) & MASK;
}
/** The stream a patient draws every one of their values from. */
export const streamFor = (seed: string, index: number): SplitMix64 => new SplitMix64(streamKeyFor(seed, index));
