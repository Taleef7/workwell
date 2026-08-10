/**
 * VSAC transport seam (E14 / live value-set expansion). `VsacValueSetResolver` calls this port to
 * expand a VSAC value-set OID; the transport is isolated here (mirrors the WebChartClient seam) so the
 * resolver core is tested against `fixtureVsacClient` with no network. `httpVsacClient` is the live
 * transport over the NLM FHIR terminology service (global `fetch`, no new dependency).
 *
 * Endpoint/auth are per NLM UTS docs (https://documentation.uts.nlm.nih.gov): FHIR
 * `GET {base}/ValueSet/{oid}/$expand`, HTTP Basic auth username `apikey` + password = the UMLS API key.
 * CONFIRM the request/response shape + paging params against the live docs before enabling in prod.
 */

/** One member concept of an expanded value set. */
export interface VsacCode {
  code: string;
  system: string;
  display?: string;
}

/** A value-set expansion for one OID. */
export interface VsacExpansion {
  oid: string;
  /** expansion.total from the server (may exceed contains.length before paging). */
  total: number;
  contains: VsacCode[];
  /** `ValueSet.version` as returned by the server — provenance for the imported row (#295). */
  version?: string;
  /** `ValueSet.expansion.identifier` — identifies THIS expansion, not the value set (#295). */
  expansionIdentifier?: string;
  /** `ValueSet.expansion.timestamp` — when the server computed the expansion (#295). */
  expansionTimestamp?: string;
}

/**
 * Release pinning (#295). Without one of these, VSAC serves *latest-active* semantics: a republish
 * silently changes our expansions and therefore the CMS122/CMS125 literal results. Pinning makes an
 * import reproducible.
 */
export interface VsacExpandOptions {
  /** Pin to a VSAC release manifest, e.g. `Library/ecqm-update-2025-05-08`. */
  manifest?: string;
  /** Pin to a named expansion (mutually exclusive with `manifest`). */
  expansion?: string;
}

export interface VsacClientConfig {
  baseUrl: string;
  apiKey: string;
}

export interface VsacClient {
  readonly kind: string;
  /** Expand one value-set OID. Rejects on transport/HTTP error or an unknown-to-this-client OID. */
  expand(oid: string, opts?: VsacExpandOptions): Promise<VsacExpansion>;
}

/** In-memory client for tests + offline fixtures. Rejects on an OID with no fixture.
 *  `calls` records the (oid, opts) it was asked for, so callers can assert pin forwarding (#295). */
export function fixtureVsacClient(
  fixtures: Record<string, VsacExpansion>,
): VsacClient & { readonly calls: Array<{ oid: string; opts?: VsacExpandOptions }> } {
  const calls: Array<{ oid: string; opts?: VsacExpandOptions }> = [];
  return {
    kind: "fixture",
    calls,
    expand(oid: string, opts?: VsacExpandOptions): Promise<VsacExpansion> {
      calls.push({ oid, opts });
      const hit = fixtures[oid];
      if (!hit) return Promise.reject(new Error(`fixtureVsacClient: no fixture for oid '${oid}'`));
      return Promise.resolve(hit);
    },
  };
}

/**
 * Live VSAC transport over the NLM FHIR terminology service. Pages `expansion.contains` until complete.
 * Throws on any non-2xx (the resolver turns a throw into a hard failure — never a silent empty set), and
 * also throws on a malformed response (no `expansion` object — e.g. an OperationOutcome), on a
 * claimed-but-empty expansion (`total > 0` but zero members returned — the ADR-008 silent-drift case),
 * and if paging exceeds the max-iteration guard (a server that ignores `offset` and never terminates).
 * A legitimately-empty value set (`total === 0` with no members) is VALID → returns `{ contains: [] }`.
 */
/**
 * Base64 for HTTP Basic, without `Buffer` — which is a Node global, not a language feature, and absent
 * from Workers (without `nodejs_compat`) and browsers alike. The package claims portability beyond the
 * Node container, so a credentialed consumer there must not throw before the request is even made
 * (Codex, #395). `TextEncoder` + `btoa` exist in all three. The UTF-8 → Latin-1 hop is what makes this
 * correct rather than merely portable: `btoa` on a raw string throws on any code point above U+00FF.
 */
function basicAuthBase64(userPass: string): string {
  const bytes = new TextEncoder().encode(userPass);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Trim trailing `/` without a regex. `replace(/\/+$/, "")` is quadratic on a long run of slashes that
 * is not at the end — the engine retries the `+` from each position — which CodeQL reports as
 * `js/polynomial-redos` (high).
 *
 * The real risk here is close to nil: the input is a CONFIG value the consumer of this package
 * supplies when constructing the client, not request data, so reaching it means configuring your own
 * VSAC base URL with tens of thousands of slashes. It is fixed anyway for a reason that has nothing
 * to do with our own exposure — this file ships inside `@work-well/measure-engine`, so the alert
 * appears in the scan of anyone who installs it, and a one-line loop is cheaper than that
 * conversation. Behaviour is unchanged for every input: all trailing slashes go, and nothing else.
 */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return url.slice(0, end);
}

export function httpVsacClient(cfg: VsacClientConfig): VsacClient {
  const base = trimTrailingSlashes(cfg.baseUrl);
  const auth = "Basic " + basicAuthBase64(`apikey:${cfg.apiKey}`);
  const PAGE = 1000;
  const MAX_PAGES = 2000;
  return {
    kind: "http",
    async expand(oid: string, opts?: VsacExpandOptions): Promise<VsacExpansion> {
      if (opts?.manifest && opts?.expansion) {
        throw new Error(`VSAC $expand for oid '${oid}': manifest and expansion are mutually exclusive`);
      }
      // Release pin (#295). Absent, VSAC serves latest-active — reproducibility depends on this.
      const pin = opts?.manifest
        ? `&manifest=${encodeURIComponent(opts.manifest)}`
        : opts?.expansion
          ? `&expansion=${encodeURIComponent(opts.expansion)}`
          : "";
      const contains: VsacCode[] = [];
      let offset = 0;
      let total = 0;
      let pages = 0;
      let sawExpansion = false;
      let version: string | undefined;
      let expansionIdentifier: string | undefined;
      let expansionTimestamp: string | undefined;
      for (;;) {
        if (++pages > MAX_PAGES) {
          throw new Error(`VSAC $expand for oid '${oid}': exceeded max pages (offset not advancing?)`);
        }
        const url = `${base}/ValueSet/${encodeURIComponent(oid)}/$expand?offset=${offset}&count=${PAGE}${pin}`;
        const res = await fetch(url, { headers: { Authorization: auth, Accept: "application/fhir+json" } });
        if (!res.ok) {
          throw new Error(`VSAC $expand failed for oid '${oid}': ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as {
          version?: string;
          expansion?: {
            total?: number;
            identifier?: string;
            timestamp?: string;
            contains?: Array<{ code?: string; system?: string; display?: string }>;
          };
        };
        if (body.expansion) sawExpansion = true;
        // Provenance comes off the first page; later pages repeat it (#295).
        version ??= body.version;
        expansionIdentifier ??= body.expansion?.identifier;
        expansionTimestamp ??= body.expansion?.timestamp;
        const page = body.expansion?.contains ?? [];
        total = body.expansion?.total ?? total;
        for (const c of page) {
          if (c.code && c.system) contains.push({ code: c.code, system: c.system, display: c.display });
        }
        offset += page.length;
        if (page.length === 0 || (total > 0 && contains.length >= total)) break;
      }
      if (!sawExpansion) {
        throw new Error(
          `VSAC $expand for oid '${oid}': response contained no expansion (malformed response or OperationOutcome)`,
        );
      }
      if (total > 0 && contains.length === 0) {
        throw new Error(`VSAC $expand for oid '${oid}': server reported total=${total} but returned no members`);
      }
      return {
        oid,
        total: total || contains.length,
        contains,
        ...(version !== undefined ? { version } : {}),
        ...(expansionIdentifier !== undefined ? { expansionIdentifier } : {}),
        ...(expansionTimestamp !== undefined ? { expansionTimestamp } : {}),
      };
    },
  };
}
