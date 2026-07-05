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
}

export interface VsacClientConfig {
  baseUrl: string;
  apiKey: string;
}

export interface VsacClient {
  readonly kind: string;
  /** Expand one value-set OID. Rejects on transport/HTTP error or an unknown-to-this-client OID. */
  expand(oid: string): Promise<VsacExpansion>;
}

/** In-memory client for tests + offline fixtures. Rejects on an OID with no fixture. */
export function fixtureVsacClient(fixtures: Record<string, VsacExpansion>): VsacClient {
  return {
    kind: "fixture",
    expand(oid: string): Promise<VsacExpansion> {
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
export function httpVsacClient(cfg: VsacClientConfig): VsacClient {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const auth = "Basic " + Buffer.from(`apikey:${cfg.apiKey}`).toString("base64");
  const PAGE = 1000;
  const MAX_PAGES = 2000;
  return {
    kind: "http",
    async expand(oid: string): Promise<VsacExpansion> {
      const contains: VsacCode[] = [];
      let offset = 0;
      let total = 0;
      let pages = 0;
      let sawExpansion = false;
      for (;;) {
        if (++pages > MAX_PAGES) {
          throw new Error(`VSAC $expand for oid '${oid}': exceeded max pages (offset not advancing?)`);
        }
        const url = `${base}/ValueSet/${encodeURIComponent(oid)}/$expand?offset=${offset}&count=${PAGE}`;
        const res = await fetch(url, { headers: { Authorization: auth, Accept: "application/fhir+json" } });
        if (!res.ok) {
          throw new Error(`VSAC $expand failed for oid '${oid}': ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as {
          expansion?: { total?: number; contains?: Array<{ code?: string; system?: string; display?: string }> };
        };
        if (body.expansion) sawExpansion = true;
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
      return { oid, total: total || contains.length, contains };
    },
  };
}
