/**
 * Routes value-set expansion by URL shape (E14): a real VSAC OID (dotted-numeric) → the VSAC tier;
 * anything else (urn:workwell:*, canonical URLs, human names) → the local store tier. This is the
 * resolver the live engine receives when VSAC is configured, so enabling VSAC never breaks the
 * local-coded measures (audiogram's `urn:workwell:vs:audiogram-procedures` still resolves locally).
 */
import type { CqlCode, ValueSetResolver } from "./value-set-resolver.ts";

/** True for a dotted-numeric OID (e.g. 2.16.840.1.113883…) — the VSAC-resolvable shape. */
export function isVsacOid(valueSetUrl: string): boolean {
  return /^\d+(\.\d+)+$/.test(valueSetUrl.trim());
}

export class CompositeValueSetResolver implements ValueSetResolver {
  constructor(
    private readonly vsac: ValueSetResolver,
    private readonly store: ValueSetResolver,
  ) {}

  expand(valueSetUrl: string): Promise<CqlCode[]> {
    return isVsacOid(valueSetUrl) ? this.vsac.expand(valueSetUrl) : this.store.expand(valueSetUrl);
  }
}
