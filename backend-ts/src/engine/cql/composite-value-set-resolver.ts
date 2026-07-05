/**
 * Routes value-set expansion by id shape (E14): a VSAC OID — bare dotted (`2.16.840…`) OR the
 * `urn:oid:2.16.840…` wrapper that this repo's authored/exported/official CQL uses (the AI CQL prompt
 * in `ai-assist.ts` and MAT export in `mat-export.ts` both emit `urn:oid:`) — goes to the VSAC tier,
 * normalized to the bare OID that VSAC's `ValueSet/{oid}/$expand` expects. Anything else
 * (`urn:workwell:*`, canonical URLs, human names) goes to the local store tier. This is the resolver the
 * live engine receives when VSAC is configured, so enabling VSAC never breaks the local-coded measures
 * (audiogram's `urn:workwell:vs:audiogram-procedures` still resolves locally). Normalizing `urn:oid:`
 * here is load-bearing: without it a `urn:oid:2.16…` reference would fall to the store, miss the
 * bare-OID-keyed VSAC import, and silently expand to an empty set (Codex P2).
 */
import type { CqlCode, ValueSetResolver } from "./value-set-resolver.ts";

/**
 * The bare dotted OID for a VSAC-resolvable id, or `null`. Accepts a bare OID (`2.16.840…`) or the
 * `urn:oid:` wrapper (`urn:oid:2.16.840…`). Returns the bare OID because that is what both the routing
 * decision and VSAC's `$expand` endpoint need; a non-OID id (`urn:workwell:*`, a canonical URL, a human
 * name) returns `null` → the store tier.
 */
export function vsacOid(valueSetUrl: string): string | null {
  const bare = valueSetUrl.trim().replace(/^urn:oid:/i, "");
  return /^\d+(\.\d+)+$/.test(bare) ? bare : null;
}

/** True when the id resolves to a VSAC OID (bare dotted or `urn:oid:`-wrapped). */
export function isVsacOid(valueSetUrl: string): boolean {
  return vsacOid(valueSetUrl) !== null;
}

export class CompositeValueSetResolver implements ValueSetResolver {
  constructor(
    private readonly vsac: ValueSetResolver,
    private readonly store: ValueSetResolver,
  ) {}

  expand(valueSetUrl: string): Promise<CqlCode[]> {
    const oid = vsacOid(valueSetUrl);
    // Route to VSAC with the BARE oid (VSAC's $expand path is the bare OID, not the urn:oid: form).
    return oid !== null ? this.vsac.expand(oid) : this.store.expand(valueSetUrl);
  }
}
