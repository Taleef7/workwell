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
 * ## At the release, named by its title (#851)
 *
 * Every expansion here asks VSAC for the release's own answer: `expansion=<the release Library's title>`,
 * one request per set. The older form, `manifest=<the Library canonical>`, resolves a grouping's members at
 * their LATEST version, so its answer drifts after the release ships (2026-10-15: Advanced Illness went
 * 2,025 → 2,027 at the 2026-05-14 release). It also filled the official Advanced Illness sidecars with
 * 2,000 codes where the 2025 release, and its published value-set file, hold 2,030. VSAC echoes the
 * release it applied as the `manifest` parameter, and `expandComplete` refuses an answer that does not
 * name the pinned one. A set the release does not list has no answer at it (`expansion=` returns
 * not-found); see `completeTerminology` for the one such set an official artifact needs.
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

import { execFileSync } from "node:child_process";
import { createHash as createHashImpl } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * Bounded retry on transport errors, 5xx, 401 and 429; any other 4xx fails immediately.
 *
 * A transient blip must not be the thing that makes a build ship a capped expansion. 401 is retried
 * because VSAC answers it intermittently for a VALID key (2026-09-22: one 401, then the same key
 * completed the same set seconds later), and the capped fallback then fails the MADiE gate's
 * reproducibility check with a misleading "does not match the pin". A genuinely bad key still fails,
 * after four attempts. A 404 (wrong OID) cannot be fixed by asking again. The URL is safe to log — the
 * credential rides in a header.
 */
const RETRYABLE_4XX = new Set([401, 429]);

/**
 * A hung request is abandoned and retried. With no bound, fetch waited 300 s per attempt when VSAC
 * stalled, which is what turned every CI run over 10 minutes into 13–16 (and 50 once re-run). Healthy
 * pages answer in under 20 s. The signal bounds reading the body too.
 */
export const VSAC_TIMEOUT_MS = 90_000;

async function fetchVsacJson(url, headers, fetchImpl, attempts = 4) {
  // Resolved per call, not at import: the tests here stub `globalThis.fetch` after importing this module,
  // and `vendor-derived-terminology.mjs` injects its own transport so its `main` can be driven offline.
  const doFetch = fetchImpl ?? globalThis.fetch;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await doFetch(url, { headers, signal: AbortSignal.timeout(VSAC_TIMEOUT_MS) });
      if (response.ok) return JSON.parse(await response.text());
      if (response.status < 500 && !RETRYABLE_4XX.has(response.status)) throw new Error(`HTTP ${response.status}`);
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
 *
 * `vsacExpansion`, when given, is the release's title and is sent as `expansion=` in place of `manifest=`
 * (#851, see the module comment); never both. The release VSAC echoes back is returned as `release`.
 *
 * `fetch` is optional and defaults to the global one; it is a transport seam, not a behaviour switch.
 */
export async function expandFromVsac(oid, { vsacBase, vsacManifest, vsacExpansion, apiKey, fetch: fetchImpl }) {
  const base = String(vsacBase).replace(/\/+$/, "");
  const headers = {
    Authorization: `Basic ${Buffer.from(`apikey:${apiKey}`).toString("base64")}`,
    Accept: "application/fhir+json",
  };
  const pin = vsacExpansion
    ? `&expansion=${encodeURIComponent(vsacExpansion)}`
    : vsacManifest
      ? `&manifest=${encodeURIComponent(vsacManifest)}`
      : "";
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
  /** The value-set version VSAC says it expanded, when it says one. */
  let echoedVersion;
  /** The release VSAC says it expanded at: the `manifest` parameter it echoes for an `expansion=` request. */
  let echoedRelease;

  for (let page = 0; ; page += 1) {
    if (page >= VSAC_MAX_PAGES) {
      throw new Error(`VSAC $expand for ${oid}: exceeded ${VSAC_MAX_PAGES} pages (offset not advancing?)`);
    }
    const url = `${base}/ValueSet/${encodeURIComponent(oid)}/$expand?offset=${offset}&count=${VSAC_PAGE}${pin}`;
    const body = await fetchVsacJson(url, headers, fetchImpl);
    // No `expansion` at all is a different failure from an empty one: the server answered with
    // something that is not an expansion, and reading that as "zero codes" is how a value set empties
    // silently — the ADR-008 drift case `httpVsacClient` guards the same way.
    if (!body.expansion) throw new Error(`VSAC $expand for ${oid}: response carries no expansion`);
    const contains = body.expansion.contains ?? [];
    if (typeof body.expansion.total === "number") total = body.expansion.total;
    if (echoedUrl === undefined && typeof body.url === "string") echoedUrl = body.url;
    if (echoedVersion === undefined && typeof body.version === "string") echoedVersion = body.version;
    if (echoedRelease === undefined) echoedRelease = releaseEchoOf(body.expansion);
    codes.push(...flattenExpansion(contains));
    offset += contains.length;
    if (contains.length === 0 || (total > 0 && codes.length >= total)) break;
  }

  if (total > 0 && codes.length === 0) {
    throw new Error(`VSAC $expand for ${oid}: claimed ${total} codes and returned none`);
  }
  // `total` stays 0 when the server volunteered none. That is NOT "zero codes" and callers must not read
  // it as a count — the absent-set path refuses on it precisely because it is an absence of evidence.
  return {
    codes,
    total,
    ...(echoedUrl ? { url: echoedUrl } : {}),
    ...(echoedVersion ? { version: echoedVersion } : {}),
    ...(echoedRelease ? { release: echoedRelease } : {}),
  };
}

/** The `manifest` parameter of an expansion, which is how VSAC names the release it applied. */
function releaseEchoOf(expansion) {
  const parameter = (expansion.parameter ?? []).find((p) => p?.name === "manifest");
  const value = parameter?.valueString ?? parameter?.valueUri ?? parameter?.valueCanonical;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Why `expandComplete` refused an answer VSAC did give. `kind` is one of `unpinned`, `empty`,
 * `no-total`, `short`, `over`, `identity`; `total`, `distinct` and `echoedUrl` carry the numbers.
 *
 * A typed error rather than a bare message so a caller that words its own warnings — the absent-upstream
 * branch of `completeTerminology`, whose sentences its tests and the runbooks already quote — can keep
 * them without parsing ours. A transport failure (`HTTP 404`, a timeout after retries) is NOT one of
 * these: it propagates as `expandFromVsac` threw it.
 */
export class IncompleteExpansionError extends Error {
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = "IncompleteExpansionError";
    this.kind = kind;
    Object.assign(this, detail);
  }
}

/**
 * One value set, expanded at a pinned release, returned ONLY if VSAC's answer is provably the whole set.
 * Every other outcome throws; there is no fallback, ever.
 *
 * The strict primitive for a value set with no other source — an absent-upstream set (ADR-053) and every
 * set in a WorkWell translation, whose terminology is 100% VSAC. Neither has upstream codes to contain or
 * an upstream declared total to fall short of, so VSAC's own `expansion.total` is the only baseline, and
 * each guard below closes a way a response can LOOK complete and not be:
 *
 * - **unpinned** — `expandFromVsac` silently drops an empty `vsacManifest` and VSAC then serves
 *   latest-active, which is not reproducible. Refused before any request.
 * - **empty** — indistinguishable from "this OID does not exist at this release", and an empty set
 *   matches nothing, so fqm reports a whole roster out-of-population (ADR-043).
 * - **no-total** — no baseline is no evidence. Review of #364 caught the first cut guarding on
 *   `total > 0 && short`, which cannot fire when VSAC omits `total` (`expandFromVsac` leaves it 0 and its
 *   loop stops on the first empty page regardless): the vacuous-guard shape, inside the guard.
 * - **short** / **over** — the DISTINCT count must equal `total` exactly. Compared after dedupe, so a
 *   response padded with duplicates cannot clear the bar and then shrink; and a response carrying more
 *   distinct codes than VSAC itself counts is one whose count and content disagree, so neither is trusted.
 * - **identity** — an echoed `url` naming a different OID would otherwise file someone else's codes under
 *   the one we asked for, and a different set of the right size passes every size check. Compared on
 *   normalized OIDs so a `|version` echo of the right set is accepted. An answer that echoes NO `url` is
 *   accepted, as the absent-upstream path always has: whether live VSAC always echoes one has not been
 *   measured, that path feeds the committed cms138 artifact, and the request path already names the OID.
 * - **release** — with `vsacExpansion` (the release's title, #851), the release VSAC echoes back must be
 *   the pinned `vsacManifest`. A title that named another release, or an answer that names none, is an
 *   expansion nobody can show was taken at the pin. Live VSAC echoes it (measured 2026-10-19).
 *
 * Returns `{ codes, total }`, codes canonicalized (deduped, sorted) because the sidecars are pinned by hash.
 */
export async function expandComplete(oid, { vsacBase, vsacManifest, vsacExpansion, apiKey, fetch: fetchImpl }) {
  if (typeof vsacManifest !== "string" || vsacManifest === "") {
    throw new IncompleteExpansionError(
      "unpinned",
      `refusing to expand ${oid} with no VSAC release pin — VSAC would serve latest-active, which no one can reproduce`,
    );
  }
  const expanded = await expandFromVsac(oid, { vsacBase, vsacManifest, vsacExpansion, apiKey, fetch: fetchImpl });
  const codes = canonicalize(expanded.codes);
  const detail = { total: expanded.total, distinct: codes.length, echoedUrl: expanded.url };
  // Ordered as the absent-upstream branch always checked, so a response failing two guards is reported
  // under the same sentence it was before this primitive existed.
  if (codes.length === 0) {
    throw new IncompleteExpansionError("empty", `VSAC returned no codes for ${oid} at ${vsacManifest}`, detail);
  }
  if (!(Number.isInteger(expanded.total) && expanded.total > 0)) {
    throw new IncompleteExpansionError(
      "no-total",
      `VSAC returned no expansion.total for ${oid}, so there is no baseline to judge completeness against`,
      detail,
    );
  }
  if (codes.length < expanded.total) {
    throw new IncompleteExpansionError(
      "short",
      `VSAC claimed ${expanded.total} codes for ${oid} and returned ${codes.length} distinct — a short read`,
      detail,
    );
  }
  if (codes.length > expanded.total) {
    throw new IncompleteExpansionError(
      "over",
      `VSAC claimed ${expanded.total} codes for ${oid} and returned ${codes.length} distinct — its count and its content disagree`,
      detail,
    );
  }
  if (expanded.url && oidFromValueSetUrl(expanded.url) !== oid) {
    throw new IncompleteExpansionError(
      "identity",
      `VSAC answered the request for ${oid} with an expansion of ${expanded.url} — a different value set`,
      detail,
    );
  }
  if (vsacExpansion && expanded.release !== vsacManifest) {
    throw new IncompleteExpansionError(
      "release",
      expanded.release
        ? `VSAC expanded ${oid} at "${vsacExpansion}" but answered for ${expanded.release}, not the pinned ${vsacManifest}`
        : `VSAC expanded ${oid} at "${vsacExpansion}" but did not say which release it expanded, so nothing shows it was ${vsacManifest}`,
      { ...detail, echoedRelease: expanded.release },
    );
  }
  return { codes, total: expanded.total, ...(expanded.version ? { version: expanded.version } : {}) };
}

/**
 * A `fetch` that runs at most `limit` requests at once, the rest queued in order. A translation's vendor
 * step expands every declared set concurrently; this keeps VSAC from seeing them all at once.
 */
export function limitConcurrency(fetchFn, limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const { args, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(() => fetchFn(...args))
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (...args) =>
    new Promise((resolve, reject) => {
      queue.push({ args, resolve, reject });
      next();
    });
}

/** VSAC's ValueSet canonical prefix: `<this><oid>` names a value set, `|<version>` a version of it. */
const VSAC_VALUESET_PREFIX = "http://cts.nlm.nih.gov/fhir/ValueSet/";

const vsacHeaders = (apiKey) => ({
  Authorization: `Basic ${Buffer.from(`apikey:${apiKey}`).toString("base64")}`,
  Accept: "application/fhir+json",
});

/**
 * The release a pin names, read once per run per `cache`: `{ canonical, title, listed }`.
 *
 * `title` is what `expansion=` names (measured 2026-10-19: "eCQM FHIR Update 2025" for
 * `Library/ecqm-fhir-update-2025`, "eCQM Update 2026-05-14" for `Library/ecqm-update-2026-05-14`).
 * `listed` holds the OIDs the Library's `relatedArtifact` lists; a set outside it has no answer at the
 * release (`expansion=` answers not-found). A Library with no title, or listing nothing, is refused: there
 * would be nothing to name, or nothing to expand.
 */
export function readRelease(vsacManifest, { vsacBase, apiKey, fetch: fetchImpl, cache = new Map() }) {
  const key = `release|${vsacManifest}`;
  // The PROMISE is cached, so concurrent callers share one request.
  if (!cache.has(key)) cache.set(key, fetchRelease(vsacManifest, { vsacBase, apiKey, fetch: fetchImpl }));
  return cache.get(key);
}

async function fetchRelease(vsacManifest, { vsacBase, apiKey, fetch: fetchImpl }) {
  const id = String(vsacManifest).split("/Library/")[1];
  if (!id) throw new Error(`the release ${vsacManifest} is not a VSAC Library canonical, so it cannot be read`);
  const base = String(vsacBase).replace(/\/+$/, "");
  const library = await fetchVsacJson(`${base}/Library/${encodeURIComponent(id)}`, vsacHeaders(apiKey), fetchImpl);
  const title = typeof library.title === "string" ? library.title.trim() : "";
  if (title === "") throw new Error(`the release ${vsacManifest} has no title, so expansion= has nothing to name`);
  const listed = new Set();
  for (const artifact of library.relatedArtifact ?? []) {
    const resource = typeof artifact?.resource === "string" ? artifact.resource : "";
    if (resource.startsWith(VSAC_VALUESET_PREFIX)) listed.add(oidFromValueSetUrl(resource));
  }
  if (listed.size === 0) throw new Error(`the release ${vsacManifest} lists no value sets`);
  return { canonical: vsacManifest, title, listed };
}

/**
 * One value set at a pinned release, in one request: `expansion=<the release's title>` (#851), held to
 * every `expandComplete` guard, the release echo included.
 *
 * This replaced a member-by-member workaround (#825). VSAC's `manifest=` expansion of a GROUPING resolves
 * each member at the member's LATEST version, so Advanced Illness drifted from 2,025 to 2,027 codes at the
 * 2026-05-14 release when a member gained a version on 2026-10-15; the workaround expanded the members at
 * the release and took their union. `expansion=` is the release's own answer for the grouping itself, and
 * it reproduced all 76 sets of the six translation sidecars byte-identically.
 *
 * A set the release does not list is refused before any expansion: there is nothing at the release to ask
 * for. `cache` shares the one Library read across a run.
 */
export async function expandAtRelease(oid, { vsacBase, vsacManifest, apiKey, fetch: fetchImpl, cache = new Map() }) {
  const release = await readRelease(vsacManifest, { vsacBase, apiKey, fetch: fetchImpl, cache });
  if (!release.listed.has(oid)) {
    throw new Error(`the release ${vsacManifest} ("${release.title}") does not list ${oid}, so VSAC has no expansion of it there`);
  }
  return expandComplete(oid, { vsacBase, vsacManifest, vsacExpansion: release.title, apiKey, fetch: fetchImpl });
}

/**
 * A pinned sidecar from a directory of content-addressed copies, `<dir>/<hex>.json`: the deploy's copy of
 * its stack's bucket, or CI's build cache (D17: images no longer carry sidecars, so the last deployed image
 * is no longer a place they can come from). Throws when the pin is unusable or the copy is absent; the
 * caller's pin check judges what it returns, never this function.
 */
export function readPinnedFromDir(dir, pin, readFile = (path) => readFileSync(path, "utf8")) {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(String(pin ?? ""))?.[1];
  if (!hex) throw new Error(`no usable terminology pin (${pin})`);
  return readFile(join(dir, `${hex}.json`));
}

/**
 * One file's text as the image `ref` holds it, through the docker CLI: create a stopped container (pulling
 * the image if absent; nothing in it runs), copy the one file out, remove the container. Throws if any
 * step fails. The vendor scripts use it to restore a pinned sidecar from the last deployed image when
 * VSAC no longer reproduces it (2026-10-15); a pin check judges what it returns, never this function.
 */
export function copyFileFromImage(ref, path) {
  const dir = mkdtempSync(join(tmpdir(), "ww-image-file-"));
  try {
    const container = execFileSync("docker", ["create", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      execFileSync("docker", ["cp", `${container}:${path}`, join(dir, "file")], { stdio: ["ignore", "pipe", "pipe"] });
      return readFileSync(join(dir, "file"), "utf8");
    } finally {
      try {
        execFileSync("docker", ["rm", container], { stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        // A leftover stopped container costs nothing and must not turn a good restore into a failure.
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whether an OFFICIAL artifact's re-vendor may be replaced by its committed state plus the sidecar the
 * last deployed image holds: only when the regenerated manifest differs from the committed one IN THE
 * `terminology` BLOCK ALONE (VSAC moved a completed value set; the bundle and everything else
 * reproduced), and the image's sidecar hashes to the committed pin. Anything else returns
 * `{ restore: false, reason }` and the re-vendor stands, so the reproducibility gate still fails on it.
 * Pure, so it is tested directly; `vendor-official-measure.mjs` does the I/O.
 */
export function officialRestoreDecision({ committedManifestText, regeneratedManifestText, imageSidecarText }) {
  const sha256 = (text) => `sha256:${createHashHex(text)}`;
  if (committedManifestText === null || committedManifestText === undefined) return { restore: false, reason: "no committed manifest to restore" };
  if (committedManifestText === regeneratedManifestText) return { restore: false, reason: "the re-vendor reproduced the committed manifest" };
  const committed = JSON.parse(committedManifestText);
  const regenerated = JSON.parse(regeneratedManifestText);
  const outsideTerminology = (manifest) => JSON.stringify({ ...manifest, terminology: undefined });
  if (outsideTerminology(committed) !== outsideTerminology(regenerated)) {
    return { restore: false, reason: "the manifest changed outside its terminology block, which no sidecar copy can explain" };
  }
  if (typeof imageSidecarText !== "string") return { restore: false, reason: "no sidecar could be copied from the image" };
  const pinned = committed.terminology?.sha256;
  const actual = sha256(imageSidecarText);
  if (actual !== pinned) return { restore: false, reason: `the image's sidecar hashes to ${actual}, not the committed pin ${pinned}` };
  return { restore: true, reason: "the image holds the committed pin's sidecar" };
}

function createHashHex(text) {
  return createHashImpl("sha256").update(text).digest("hex");
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
 * The MADiE gate is NOT an oracle for the one absent set an official artifact holds today (cms138's
 * …3.526.3.1278): no CMS138 expression reads it (a `valueset` declaration the CQL never uses). The gate
 * shows only that fqm finds it, which it must, since fqm throws on any declared set missing from its cache.
 *
 * ## Both are taken at the release (#851)
 *
 * Every set the release lists is expanded at it by title (`expandComplete` with `vsacExpansion`), so a
 * capped completion is held to VSAC's own exact total and to the release echo, as well as to upstream's
 * declared count and shipped sample. A CAPPED set the release does not list is left as upstream shipped
 * it. An ABSENT one cannot be (fqm would refuse the measure), so it is sourced as VSAC serves it, warned
 * about, and its record says `inRelease: false`: cms138's 1278 is that set (not in eCQM FHIR Update 2025).
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

  let release;
  try {
    release = await readRelease(args.vsacManifest, { vsacBase: args.vsacBase, apiKey });
  } catch (err) {
    console.warn(
      `  WARNING could not read the VSAC release ${args.vsacManifest}: ${err.message}. Leaving` +
        ` ${capped.length} capped and ${absent.length} absent value set(s) as upstream shipped them.` +
        " Routing will refuse.",
    );
    return [];
  }
  const atRelease = { ...args, apiKey, vsacExpansion: release.title };

  const completed = [];
  for (const valueSet of capped) {
    const had = valueSet.codes.length;
    if (!release.listed.has(valueSet.oid)) {
      console.warn(
        `  WARNING ${valueSet.oid} is not in the release ${release.title}, so it has no expansion there —` +
          ` keeping upstream's ${had}. Routing will refuse.`,
      );
      continue;
    }
    let expanded;
    try {
      // Exact: VSAC's distinct codes must equal its own total, at the pinned release (#851). Answering
      // "not short of what upstream declared" was the hole: 2,000 accepted against a declared 1,997.
      expanded = await expandComplete(valueSet.oid, atRelease);
    } catch (err) {
      console.warn(`  WARNING could not complete ${valueSet.oid} from VSAC at ${release.title}: ${err.message}`);
      continue;
    }
    // Already canonicalized by `expandComplete`, and compared AFTER dedupe for that reason: a response
    // padded with duplicate system|code pairs must not clear the bar and then shrink below it.
    const canonical = expanded.codes;
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
  //
  // The guards themselves live in `expandComplete`, the one strict primitive this path shares with a
  // WorkWell translation's sidecar (`vendor-derived-terminology.mjs`), so the two can never apply
  // different standards to a set VSAC alone vouches for. This branch only words the refusal.
  //
  // A set the release lists is taken at it, as a capped one is. One it does not list has no answer there
  // (`expansion=` is not-found), and leaving it absent would make fqm refuse the whole measure, so it is
  // asked for with `manifest=`, which VSAC ignores for a set outside the release and answers with the
  // set as it serves it. Every other guard still applies; the release echo cannot, and the record says so.
  const stillAbsent = [];
  for (const want of absent) {
    const inRelease = release.listed.has(want.oid);
    if (!inRelease) {
      console.warn(
        `  WARNING ${want.oid} is not in the release ${release.title}: VSAC has no expansion of it there, so it` +
          " is sourced as VSAC serves it and recorded with inRelease: false.",
      );
    }
    let expanded;
    try {
      expanded = await expandComplete(want.oid, inRelease ? atRelease : { ...args, apiKey });
    } catch (err) {
      console.warn(absentRefusal(want.oid, err, args.vsacManifest));
      stillAbsent.push(want);
      continue;
    }
    terminology.valueSets.push({
      url: want.url,
      oid: want.oid,
      // The sidecar's own truncation bookkeeping, NOT a claim about what upstream declared — upstream
      // declared nothing. `buildManifest` derives `truncated` from `declaredTotal > codes.length`, so
      // this must be the count we actually hold or a phantom truncation would appear. `expandComplete`
      // guarantees VSAC's total equals the distinct codes we hold, so it is both.
      declaredTotal: expanded.total,
      codes: expanded.codes,
    });
    completed.push({
      oid: want.oid,
      reason: "absent-upstream",
      // Only when false: a set the release lists needs no marker, and a committed record's keys are its bytes.
      ...(inRelease ? {} : { inRelease: false }),
      had: 0,
      now: expanded.codes.length,
      // Null, not VSAC's total: this field means "what the bundle declared", and for an absent set the
      // bundle declared nothing. Reporting VSAC's number here would read as upstream corroboration.
      declaredTotal: null,
    });
  }
  terminology.absent = stillAbsent;
  return completed;
}

/**
 * The warning for an absent set `expandComplete` would not source, in the sentences this path has always
 * printed. Each says "leaving it absent" because that is the operator's fact: routing keeps refusing.
 */
function absentRefusal(oid, err, vsacManifest) {
  if (!(err instanceof IncompleteExpansionError)) {
    return `  WARNING could not source absent value set ${oid} from VSAC: ${err.message}`;
  }
  switch (err.kind) {
    case "empty":
      return (
        `  WARNING VSAC returned no codes for absent value set ${oid} at ${vsacManifest};` +
        " leaving it absent so routing keeps refusing."
      );
    case "no-total":
      return (
        `  WARNING VSAC returned no expansion.total for absent value set ${oid}, so there is no` +
        " baseline to judge completeness against — an absent set has no upstream codes to contain and" +
        " no declared total to fall short of. Leaving it absent."
      );
    case "short":
      return (
        `  WARNING VSAC claimed ${err.total} codes for absent value set ${oid} and returned` +
        ` ${err.distinct} distinct — a short read, not an expansion. Leaving it absent.`
      );
    case "over":
      return (
        `  WARNING VSAC claimed ${err.total} codes for absent value set ${oid} and returned` +
        ` ${err.distinct} distinct — its count and its content disagree. Leaving it absent.`
      );
    case "identity":
      return (
        `  WARNING VSAC answered the request for ${oid} with an expansion of ${err.echoedUrl} —` +
        " a different value set. Leaving it absent rather than filing someone else's codes under this" +
        " OID."
      );
    default:
      return `  WARNING could not source absent value set ${oid} from VSAC: ${err.message}. Leaving it absent.`;
  }
}

/**
 * Dedupe and sort by `system|code`.
 *
 * The sidecar is pinned by hash, so its ORDERING is part of the artifact, and VSAC's page order is not
 * a contract. Code-point comparison rather than `localeCompare` for the reason `collectTerminology`'s
 * own sort spells out: ICU collation of punctuation is locale- and build-dependent, and a dev-vs-CI
 * divergence would surface as a hash mismatch whose remedy is "re-vendor" — which reproduces it.
 *
 * Exported so a translation's sidecar is canonicalized by the same function as an official one.
 */
export function canonicalize(codes) {
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
