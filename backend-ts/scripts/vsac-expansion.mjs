/**
 * Completing a VSAC-capped value-set expansion at VENDOR time (roadmap §7.3, PR-9).
 *
 * Split out of `vendor-official-measure.mjs` so it can be tested directly rather than only through a
 * 17 MB download and a `git diff`. It stays a plain `.mjs` with no imports beyond node built-ins for
 * the same reason the vendor script does: that script runs as bare `node` on the DEPLOY path, with no
 * install and no build step, and importing a sibling module preserves that exactly.
 *
 * ## Why this exists at all
 *
 * `cqframework/dqm-content-qicore-2025` caps every expansion it ships — its own README says so:
 * *"The value sets in this repository are limited to expansions of 1000."* Full expansions require an
 * NLM licence, so this is upstream policy rather than a defect, and there is nothing to file about it.
 *
 * It matters because `AdvancedIllness` (2.16.840.1.113883.3.464.1003.110.12.1082) is **1000 of 1997
 * codes** in both vendored bundles and feeds the 66+/advanced-illness denominator exclusion in each. A
 * capped exclusion set does not fail — it narrows a population silently, leaving subjects who should
 * have been excluded in the denominator to be scored. `officialRoutingProblems` refuses to route any
 * measure whose ELM retrieves one, which is why cms122 and cms125 are deliberately not routable until
 * this runs.
 *
 * ## The one thing to hold onto
 *
 * Every failure path here leaves upstream's codes exactly as shipped, so the manifest's `truncated`
 * entry survives and routing keeps refusing. There is no path that produces a set which *looks*
 * complete and is not. Two of those paths are not obvious:
 *
 * - An expansion that comes back SHORT is rejected rather than merged, because swapping upstream's
 *   1000 codes for a different, still-incomplete 800 is a narrowing dressed as a fix. The comparison
 *   is made AFTER dedupe, so a response padded with duplicates cannot clear it and then shrink.
 * - An expansion of the right SIZE that does not CONTAIN upstream's shipped codes is also rejected.
 *   A count cannot tell "the full version of this set" from "a different set that happens to be
 *   bigger", and the difference is a wrong release pin scoring real patients.
 */

/** NLM's FHIR terminology service — the same host `engine/cql/vsac-client.ts` expands against. */
export const DEFAULT_VSAC_BASE = "https://cts.nlm.nih.gov/fhir";

/**
 * The release pin, and it is not a guess: the upstream content repo names this manifest as the
 * official terminology package supporting its measures, and CVU+ validates the 2026 reporting period
 * against the same eCQM release — so pinning here keeps M-A and M-B on one terminology story.
 *
 * Unpinned, VSAC serves *latest-active*: a republish would move our expansions, the terminology
 * digest, and therefore `officialLogicVersion`, with the bundle bytes unchanged. A vendor step that is
 * not reproducible is not provenance, and CI's `git diff --exit-code measures/official` is what would
 * catch it — after the fact, on an unrelated PR.
 */
export const DEFAULT_VSAC_MANIFEST = "http://cts.nlm.nih.gov/fhir/Library/ecqm-fhir-update-2025";

/** VSAC caps a page at 1000 whatever `count` asks for; asking for exactly that is honest. */
const VSAC_PAGE = 1000;

/** An offset that stops advancing would otherwise spin forever. Mirrors `httpVsacClient`. */
const VSAC_MAX_PAGES = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Flatten a FHIR expansion's `contains` tree. VSAC's is flat, but the field is recursive. */
export function flattenExpansion(contains, out = []) {
  for (const item of contains ?? []) {
    if (typeof item.code === "string" && typeof item.system === "string") {
      out.push({ system: item.system, code: item.code });
    }
    flattenExpansion(item.contains, out);
  }
  return out;
}

/**
 * Bounded retry on transport errors and 5xx; 4xx fails immediately.
 *
 * Same policy as the vendor script's bundle fetch and for the same reason: a transient blip must not
 * be the thing that makes a build ship a capped expansion, while a 401 (bad key) or 404 (wrong OID)
 * cannot be fixed by asking again. The URL is safe to log — the credential rides in a header.
 */
async function fetchVsacJson(url, headers, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return JSON.parse(await response.text());
      if (response.status < 500) throw new Error(`HTTP ${response.status}`);
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      if (/^HTTP 4/.test(String(err.message))) throw err;
      lastError = err;
    }
    if (attempt < attempts) {
      const backoffMs = 1000 * 2 ** (attempt - 1);
      console.warn(`  VSAC attempt ${attempt}/${attempts} failed (${lastError.message}); retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }
  throw lastError;
}

/**
 * One value set, expanded in full at a pinned release, paging `offset`/`count`.
 *
 * `offset` advances by the page's own length, never by `count`: a short page must still terminate, and
 * a server that ignores `offset` must not loop forever — hence the page ceiling.
 */
export async function expandFromVsac(oid, { vsacBase, vsacManifest, apiKey }) {
  const base = String(vsacBase).replace(/\/+$/, "");
  const headers = {
    Authorization: `Basic ${Buffer.from(`apikey:${apiKey}`).toString("base64")}`,
    Accept: "application/fhir+json",
  };
  const pin = vsacManifest ? `&manifest=${encodeURIComponent(vsacManifest)}` : "";
  const codes = [];
  let offset = 0;
  let total = 0;

  for (let page = 0; ; page += 1) {
    if (page >= VSAC_MAX_PAGES) {
      throw new Error(`VSAC $expand for ${oid}: exceeded ${VSAC_MAX_PAGES} pages (offset not advancing?)`);
    }
    const url = `${base}/ValueSet/${encodeURIComponent(oid)}/$expand?offset=${offset}&count=${VSAC_PAGE}${pin}`;
    const body = await fetchVsacJson(url, headers);
    // No `expansion` at all is a different failure from an empty one: the server answered with
    // something that is not an expansion, and reading that as "zero codes" is how a value set empties
    // silently — the ADR-008 drift case `httpVsacClient` guards the same way.
    if (!body.expansion) throw new Error(`VSAC $expand for ${oid}: response carries no expansion`);
    const contains = body.expansion.contains ?? [];
    if (typeof body.expansion.total === "number") total = body.expansion.total;
    codes.push(...flattenExpansion(contains));
    offset += contains.length;
    if (contains.length === 0 || (total > 0 && codes.length >= total)) break;
  }

  if (total > 0 && codes.length === 0) {
    throw new Error(`VSAC $expand for ${oid}: claimed ${total} codes and returned none`);
  }
  return { codes, total };
}

/**
 * Complete every expansion upstream capped, in place, and report what actually moved.
 *
 * Returns the completion report the manifest records. An empty report means nothing changed — which
 * is the correct outcome for "no capped sets", "flag not passed", "no key", and "VSAC said no"
 * alike, and each of the last three says so on stderr rather than passing quietly.
 */
export async function completeCappedExpansions(terminology, args, env = process.env) {
  const capped = terminology.valueSets.filter((v) => v.declaredTotal > v.codes.length);
  if (capped.length === 0 || !args.completeCappedExpansions) return [];

  const apiKey = env.WORKWELL_VSAC_API_KEY;
  if (!apiKey) {
    console.warn(
      "  WARNING --complete-capped-expansions was passed but WORKWELL_VSAC_API_KEY is unset;" +
        ` leaving ${capped.length} capped expansion(s) as upstream shipped them. Routing will refuse.`,
    );
    return [];
  }

  const completed = [];
  for (const valueSet of capped) {
    const had = valueSet.codes.length;
    let expanded;
    try {
      expanded = await expandFromVsac(valueSet.oid, { ...args, apiKey });
    } catch (err) {
      console.warn(`  WARNING could not complete ${valueSet.oid} from VSAC: ${err.message}`);
      continue;
    }
    // Canonicalize BEFORE comparing. Comparing the raw page total would let a response carrying
    // duplicate system|code pairs clear the bar and then dedupe below the declared total — replacing
    // upstream's codes with a set that is short after all, which is the one outcome this guard exists
    // to prevent.
    const canonical = canonicalize(expanded.codes);
    if (canonical.length < valueSet.declaredTotal) {
      console.warn(
        `  WARNING VSAC returned ${canonical.length} distinct codes for ${valueSet.oid}, short of the` +
          ` ${valueSet.declaredTotal} the bundle declares — keeping upstream's ${had} rather than` +
          " swapping in a differently-incomplete set. Routing will refuse.",
      );
      continue;
    }
    // A count says nothing about identity. Upstream shipped a real (if truncated) sample of this value
    // set, so the full expansion must CONTAIN it; if it does not, the pinned release is not the one the
    // bundle was built against and we would be silently substituting a different set of the right size.
    const present = new Set(canonical.map((c) => `${c.system}|${c.code}`));
    const missing = valueSet.codes.filter((c) => !present.has(`${c.system}|${c.code}`));
    if (missing.length > 0) {
      console.warn(
        `  WARNING VSAC's expansion of ${valueSet.oid} is missing ${missing.length} of the ${had} codes` +
          " upstream shipped (e.g. " +
          `${missing[0].system}|${missing[0].code}) — the pinned release does not look like the one this` +
          " bundle was built against. Keeping upstream's codes. Routing will refuse.",
      );
      continue;
    }
    valueSet.codes = canonical;
    completed.push({
      oid: valueSet.oid,
      had,
      now: valueSet.codes.length,
      declaredTotal: valueSet.declaredTotal,
    });
  }
  return completed;
}

/**
 * Dedupe and sort by `system|code`.
 *
 * The sidecar is pinned by hash, so its ORDERING is part of the artifact, and VSAC's page order is not
 * a contract. Code-point comparison rather than `localeCompare` for the reason `collectTerminology`'s
 * own sort spells out: ICU collation of punctuation is locale- and build-dependent, and a dev-vs-CI
 * divergence would surface as a hash mismatch whose remedy is "re-vendor" — which reproduces it.
 */
function canonicalize(codes) {
  const seen = new Set();
  const merged = [];
  for (const code of codes) {
    const key = `${code.system}|${code.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(code);
  }
  merged.sort((a, b) => {
    const ka = `${a.system}|${a.code}`;
    const kb = `${b.system}|${b.code}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return merged;
}
