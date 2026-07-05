/**
 * Live VSAC resolver behind the ValueSetResolver port (E14). Expands a real VSAC OID → member codes via
 * the injected VsacClient, memoized per-OID for the resolver's lifetime (value sets are stable within a
 * process). A transport/HTTP error PROPAGATES (throws) — the engine must fail visibly rather than
 * mis-evaluate compliance against a silently-empty value set (ADR-008). Descriptive only — never
 * decides compliance.
 */
import type { CqlCode, ValueSetResolver } from "./value-set-resolver.ts";
import type { VsacClient } from "./vsac-client.ts";

export class VsacValueSetResolver implements ValueSetResolver {
  private readonly cache = new Map<string, Promise<CqlCode[]>>();
  constructor(private readonly client: VsacClient) {}

  expand(valueSetUrl: string): Promise<CqlCode[]> {
    let hit = this.cache.get(valueSetUrl);
    if (!hit) {
      hit = this.client
        .expand(valueSetUrl)
        .then((e) => e.contains.map((c) => ({ code: c.code, system: c.system })));
      // Do not cache a rejected expand — a transient failure should be retryable on the next call.
      hit.catch(() => this.cache.delete(valueSetUrl));
      this.cache.set(valueSetUrl, hit);
    }
    return hit;
  }
}
