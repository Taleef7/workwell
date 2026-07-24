/**
 * `logic_version` — the measure-logic change signal for incremental evaluation (#263, Phase 2a).
 * A cached outcome is reusable only if the measure's *logic* is unchanged, which means two things
 * (design §3 invalidation matrix):
 *   - the compiled **ELM** is unchanged (hashing the ELM, not the CQL text, so a whitespace/comment
 *     edit that recompiles to identical ELM does NOT invalidate, but a semantic recompile does), AND
 *   - every value set the measure references still expands to the same codes — captured by folding in
 *     the `value_sets.expansion_hash` of each referenced set (DATA_MODEL §3.4). This is the
 *     invalidation everyone forgets: a VSAC re-import can flip membership with no CQL change.
 *
 * For the demo/live tenants (twh/ihn) the measures use inline `urn:workwell:*` codes with no expanded
 * value sets, so `expansionHashes` is empty and `logic_version` is effectively `hash(ELM)`. The value-set
 * component only bites when VSAC expansion is enabled (cms122/cms125) — inert on the demo stack.
 *
 * Pure + dependency-free: the caller supplies the ELM object and the referenced expansion hashes; this
 * only hashes them. WebCrypto SHA-256, house `sha256:<hex>` format (mirrors `canonical-hash.ts`).
 * Descriptive only (ADR-008) — it decides *whether* to re-run CQL, never the answer.
 */

/**
 * `sha256:<hex>` over the canonicalized ELM plus the sorted expansion hashes of the value sets the
 * measure references. Expansion hashes are sorted so their order (a store-read artifact) never changes
 * the result; each is included verbatim (already `sha256:`/`h<hex>`-prefixed on the row).
 */
export async function computeLogicVersion(elm: unknown, expansionHashes: readonly string[] = []): Promise<string> {
  const payload = JSON.stringify({
    elm: canonicalJson(elm),
    valueSets: [...expansionHashes].sort(),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

/** Recursively key-sorted JSON so ELM object-key order (a compiler artifact) can't false-invalidate. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = canonicalJson((value as Record<string, unknown>)[k]);
  }
  return out;
}
