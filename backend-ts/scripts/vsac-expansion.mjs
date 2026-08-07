/**
 * Completing an INCOMPLETE value-set expansion at VENDOR time (roadmap §7.3, PR-9 / ADR-041, ADR-053).
 *
 * Split out of `vendor-official-measure.mjs` so it can be tested directly rather than only through a
 * 17 MB download and a `git diff`. It stays a plain `.mjs` with no imports beyond node built-ins for
 * the same reason the vendor script does: that script runs as bare `node` on the DEPLOY path, with no
 * install and no build step, and importing a sibling module preserves that exactly.
 *
 * ## Two different incompletenesses, and only one of them used to be modelled
 *
 * **CAPPED (ADR-041).** `cqframework/dqm-content-qicore-2025` caps every expansion it ships — its own
 * README says so: *"The value sets in this repository are limited to expansions of 1000."* Full
 * expansions require an NLM licence, so this is upstream policy rather than a defect, and there is
 * nothing to file about it. It matters because `AdvancedIllness`
 * (2.16.840.1.113883.3.464.1003.110.12.1082) is **1000 of 1997 codes** in both vendored bundles and
 * feeds the 66+/advanced-illness denominator exclusion in each. A capped exclusion set does not fail —
 * it narrows a population silently, leaving subjects who should have been excluded in the denominator
 * to be scored.
 *
 * **ABSENT (ADR-053).** A value set the ELM DECLARES that the bundle does not ship *at all*. Measured
 * on CMS138 at the pinned commit: its libraries declare **32** value sets and the bundle carries **31**
 * ValueSet resources — `2.16.840.1.113883.3.526.3.1278` ("Tobacco Use Screening") is simply not there.
 * This was invisible here until ADR-053 because `collectTerminology` enumerates the ValueSets the
 * bundle SHIPS: an absent one produced no sidecar entry, no `truncated` row and no warning, so the
 * manifest read as terminology-complete and the failure surfaced only as an opaque runtime
 * "could not be expanded" — which sends an operator at our sidecar, our pin and our fetch, none of
 * which are the cause.
 *
 * The two are NOT interchangeable and the code keeps them apart, because the evidence available for
 * each is different (see `completeTerminology`).
 *
 * ## The one thing to hold onto
 *
 * Every failure path here leaves upstream's terminology exactly as shipped, so the manifest's
 * `truncated`/`absent` entry survives and routing keeps refusing. There is no path that produces a set
 * which *looks* complete and is not. Three of those paths are not obvious:
 *
 * - An expansion that comes back SHORT is rejected rather than merged, because swapping upstream's
 *   1000 codes for a different, still-incomplete 800 is a narrowing dressed as a fix. The comparison
 *   is made AFTER dedupe, so a response padded with duplicates cannot clear it and then shrink.
 * - An expansion of the right SIZE that does not CONTAIN upstream's shipped codes is also rejected.
 *   A count cannot tell "the full version of this set" from "a different set that happens to be
 *   bigger", and the difference is a wrong release pin scoring real patients.
 * - An ABSENT set has neither check available (there are no upstream codes to contain and no declared
 *   total to fall short of), so it is held to the only baseline that exists — VSAC's own
 *   `expansion.total` — and REFUSED outright when the server volunteers none, because then there is no
 *   evidence of completeness at all. (Review of #364 caught the first cut guarding on
 *   `total > 0 && short`, which cannot fire when `total` is absent — the vacuous shape, inside the
 *   guard.) It is recorded under a distinct `reason` so it can never be read as evidence of the same
 *   strength as a completed cap.
 */

/** NLM's FHIR terminology service — the same host `@work-well/measure-engine`'s `vsac-client.ts` expands against. */
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

/**
 * `http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840...|1.2` → `2.16.840...`.
 *
 * The single `.mjs` implementation: the vendor script and the terminology audit both import it rather
 * than keeping private copies, which is how #364 shipped with three copies of one rule and a
 * normalization missing from all of them. It deliberately mirrors `oidFromValueSetUrl` in
 * `@work-well/official-executor` — the duplication is forced (this file runs as bare `node` on the
 * deploy path and cannot import the workspace package) and `valueset-parity.test.mjs` pins the two
 * against each other over the real artifacts.
 *
 * Stripping the `|version` suffix matters even though **no canonical in any of the six upstream bundles
 * carries one today** (measured at the pinned commit, review of #364): a shipped `ValueSet.url` never
 * has a version — it lives in `ValueSet.version` — so a versioned ELM canonical would be keyed
 * differently from the terminology holding it, and reported ABSENT while present.
 */
export function oidFromValueSetUrl(url) {
  const marker = "/ValueSet/";
  const withoutPrefix = url.includes(marker) ? url.slice(url.lastIndexOf(marker) + marker.length) : url;
  const pipe = withoutPrefix.indexOf("|");
  return pipe === -1 ? withoutPrefix : withoutPrefix.slice(0, pipe);
}

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
  /**
   * The identity VSAC echoes back, when it echoes one — see the absent-set guard in
   * `completeTerminology`. Named `echoedUrl` and NOT `url`, because the loop below declares its own
   * `const url` for the REQUEST: the first cut shadowed this one, so `url === undefined` compared a
   * request string against undefined, was never true, and the identity check could never fire. Caught
   * by its own test, which is the only reason it is not in this PR.
   */
  let echoedUrl;

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
    if (echoedUrl === undefined && typeof body.url === "string") echoedUrl = body.url;
    codes.push(...flattenExpansion(contains));
    offset += contains.length;
    if (contains.length === 0 || (total > 0 && codes.length >= total)) break;
  }

  if (total > 0 && codes.length === 0) {
    throw new Error(`VSAC $expand for ${oid}: claimed ${total} codes and returned none`);
  }
  // `total` stays 0 when the server volunteered none. That is NOT "zero codes" and callers must not read
  // it as a count — the absent-set path refuses on it precisely because it is an absence of evidence.
  return { codes, total, ...(echoedUrl ? { url: echoedUrl } : {}) };
}

/**
 * Every distinct value-set canonical the measure's ELM DECLARES, across all libraries in a bundle.
 *
 * DECLARES, not retrieves: this is `library.valueSets.def`, which lists what the CQL *could* use.
 * Measured in review of #364, CMS138 declares one it never references in any `Retrieve` — so any
 * check built on this over-approximates, which is the safe direction and must be said out loud
 * rather than papered over with the word "retrieves".
 *
 * A deliberate mirror of `referencedValueSets` in `@work-well/official-executor`, reimplemented here
 * because this file runs as bare `node` on the deploy path with no install and no build step (see the
 * header) — it cannot import the package. The duplication is the cost of that, and it is bounded: the
 * two read the SAME field of the SAME artifact with the same de-duplication, and
 * `official-terminology-absent.test.ts` pins them against each other on the real vendored bundles so a
 * divergence fails rather than drifts.
 *
 * Read from the compiled ELM rather than the CQL text, so it reflects what will actually execute — and
 * computed from the REDUCED bundle, which is the same input `requiredOids(artifact)` reads at runtime.
 * That is what makes the vendor-time record and the routing refusal agree by construction rather than
 * by two lists being kept in step.
 */
export function declaredValueSets(bundle) {
  const byUrl = new Map();
  for (const entry of bundle.entry ?? []) {
    const resource = entry?.resource;
    if (resource?.resourceType !== "Library") continue;
    const data = (resource.content ?? []).find((c) => c.contentType === "application/elm+json")?.data;
    if (!data) continue;
    // Deliberately NOT tolerant, matching the executor package: a library whose ELM will not parse
    // means the value sets it retrieves are missing from the cache, and swallowing that here would
    // trade a precise parse error for an opaque failure deep inside fqm at evaluation time.
    const elm = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    for (const def of elm.library?.valueSets?.def ?? []) {
      if (!byUrl.has(def.id)) byUrl.set(def.id, { url: def.id, ...(def.name ? { name: def.name } : {}) });
    }
  }
  return [...byUrl.values()];
}

/**
 * Sort a terminology sidecar's value sets into the canonical order its hash is taken over.
 *
 * Called explicitly by the vendor script AFTER completion rather than folded into either step, because
 * completion can APPEND a value set (an absent one sourced from VSAC) and an append after the sort
 * would make the sidecar's bytes depend on how many sets happened to be absent. Idempotent.
 *
 * Code-point comparison, NOT `localeCompare`: this ordering decides the bytes that get hashed, and ICU
 * collation weights punctuation (`.` — every character in an OID that is not a digit) according to
 * locale and ICU build. A dev-vs-CI divergence would surface as a hash mismatch whose remedy message
 * says "re-vendor", which would reproduce the same mismatch.
 */
export function sortValueSets(terminology) {
  terminology.valueSets.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  return terminology;
}

/**
 * Complete every INCOMPLETE expansion in place — capped and absent alike — and report what moved.
 *
 * Returns the completion report the manifest records. An empty report means nothing changed — which is
 * the correct outcome for "nothing incomplete", "flag not passed", "no key", and "VSAC said no" alike,
 * and each of the last three says so on stderr rather than passing quietly.
 *
 * ## Why capped and absent are not one loop
 *
 * They admit different evidence, and collapsing them would silently apply the weaker standard to both:
 *
 * - A CAPPED set has upstream's own `declaredTotal` and a real (if truncated) sample of its members, so
 *   the completion can be checked for size AND identity. Both checks are enforced below.
 * - An ABSENT set has neither. Upstream shipped nothing, so "does the full expansion contain what
 *   upstream shipped" has no left-hand side, and "is it short of the declared total" has no declared
 *   total. The only baseline that exists is VSAC's own `expansion.total`; a response carrying none is
 *   refused rather than trusted. A genuinely weaker check either way, which is why the completion record
 *   carries a distinct `reason` so nobody downstream reads the two as equally evidenced.
 *
 * The real check on an absent set is not here at all: it is the MADiE gate. Upstream's 2026-07-15
 * discrepancy report lists CMS138 under "no discrepancies" across 5826 cases, so its 47 committed
 * expected population vectors are an external oracle for whether the set we sourced is the set the
 * measure was authored against. 0/47 today; a sourced set that is wrong does not go green.
 */
export async function completeTerminology(terminology, args, env = process.env) {
  const capped = terminology.valueSets.filter((v) => v.declaredTotal > v.codes.length);
  const absent = terminology.absent ?? [];
  if ((capped.length === 0 && absent.length === 0) || !args.completeTerminology) return [];

  const apiKey = env.WORKWELL_VSAC_API_KEY;
  if (!apiKey) {
    console.warn(
      "  WARNING --complete-terminology was passed but WORKWELL_VSAC_API_KEY is unset; leaving" +
        ` ${capped.length} capped and ${absent.length} absent value set(s) as upstream shipped them.` +
        " Routing will refuse.",
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
    // NO `reason` key on the capped path, deliberately, and this is a REPRODUCIBILITY constraint rather
    // than a style choice. The committed cms122/cms125 manifests were written by a credentialed run
    // before ADR-053 and record exactly `{oid, had, now, declaredTotal}`. Adding a field here changes
    // the bytes a credentialed re-vendor produces, and CI plus both deploy workflows run
    // `git diff --exit-code measures/official` immediately afterwards — so it fails the eCQM gate and
    // BLOCKS DEPLOYS until someone re-vendors with the key. It did exactly that on the first push of
    // this PR, and the local cms2 verification could not have caught it: cms2 has no completion block.
    //
    // An absent `reason` reads as `capped`, which is what every completion before ADR-053 was. The field
    // then means what it should — a marker on the WEAKER provenance, rather than a label on both.
    completed.push({
      oid: valueSet.oid,
      had,
      now: valueSet.codes.length,
      declaredTotal: valueSet.declaredTotal,
    });
  }

  // ABSENT sets (ADR-053). Sourced whole from VSAC because upstream's bundle carries no ValueSet
  // resource for them at all — see the `reason` split above for why this is a weaker claim than a
  // completed cap, and why it is recorded as such rather than merged into the same bucket.
  const stillAbsent = [];
  for (const want of absent) {
    let expanded;
    try {
      expanded = await expandFromVsac(want.oid, { ...args, apiKey });
    } catch (err) {
      console.warn(`  WARNING could not source absent value set ${want.oid} from VSAC: ${err.message}`);
      stillAbsent.push(want);
      continue;
    }
    const canonical = canonicalize(expanded.codes);
    // An empty expansion is the one outcome indistinguishable from "this OID does not exist at this
    // release". Recording it as sourced would hand the executor an empty set, which fqm matches against
    // nothing — reporting a whole roster out-of-population, the exact ADR-043 silence.
    if (canonical.length === 0) {
      console.warn(
        `  WARNING VSAC returned no codes for absent value set ${want.oid} at ${args.vsacManifest};` +
          " leaving it absent so routing keeps refusing.",
      );
      stillAbsent.push(want);
      continue;
    }
    // VSAC's own `expansion.total` is the ONLY size baseline an absent set has, so a response that does
    // not carry one carries NO evidence of completeness and is refused.
    //
    // Review of #364 caught the first cut here as `expanded.total > 0 && canonical.length < expanded.total`
    // — which cannot fire when the server omits `total`, because `expandFromVsac` leaves it 0 and the
    // paging loop stops on the first empty page regardless. A short response with no `total` was accepted
    // silently, written with `declaredTotal` equal to whatever arrived, `truncated` empty and no warning:
    // a set that LOOKS complete and is not, which is the one thing this file's header says no path
    // produces. That is the vacuous-guard shape, inside the guard added to close a blind spot.
    if (!(expanded.total > 0)) {
      console.warn(
        `  WARNING VSAC returned no expansion.total for absent value set ${want.oid}, so there is no` +
          " baseline to judge completeness against — an absent set has no upstream codes to contain and" +
          " no declared total to fall short of. Leaving it absent.",
      );
      stillAbsent.push(want);
      continue;
    }
    if (canonical.length < expanded.total) {
      console.warn(
        `  WARNING VSAC claimed ${expanded.total} codes for absent value set ${want.oid} and returned` +
          ` ${canonical.length} distinct — a short read, not an expansion. Leaving it absent.`,
      );
      stillAbsent.push(want);
      continue;
    }
    // Identity, when the server volunteers it: a response echoing a DIFFERENT canonical would otherwise
    // be written under the OID we asked for. Applied here and not to the capped path above, because the
    // capped path already proves identity a stronger way — the expansion must CONTAIN the codes upstream
    // shipped (ADR-041) — and tightening a guard we cannot re-run against live VSAC would risk the
    // reproducibility of the committed artifacts for no measured gain.
    if (expanded.url && oidFromValueSetUrl(expanded.url) !== want.oid) {
      console.warn(
        `  WARNING VSAC answered the request for ${want.oid} with an expansion of ${expanded.url} —` +
          " a different value set. Leaving it absent rather than filing someone else's codes under this" +
          " OID.",
      );
      stillAbsent.push(want);
      continue;
    }
    terminology.valueSets.push({
      url: want.url,
      oid: want.oid,
      // The sidecar's own truncation bookkeeping, NOT a claim about what upstream declared — upstream
      // declared nothing. `buildManifest` derives `truncated` from `declaredTotal > codes.length`, so
      // this must be the count we actually hold or a phantom truncation would appear. VSAC's own total
      // when it gave one (we refused a short read above, so it can never exceed what we hold).
      declaredTotal: expanded.total > 0 ? expanded.total : canonical.length,
      codes: canonical,
    });
    completed.push({
      oid: want.oid,
      reason: "absent-upstream",
      had: 0,
      now: canonical.length,
      // Null, not VSAC's total: this field means "what the bundle declared", and for an absent set the
      // bundle declared nothing. Reporting VSAC's number here would read as upstream corroboration.
      declaredTotal: null,
    });
  }
  terminology.absent = stillAbsent;
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
