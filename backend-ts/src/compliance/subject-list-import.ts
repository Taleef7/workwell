/**
 * Parsing, the sandbox data boundary, and identifier resolution for an attributed-list import
 * (MM-2 PR 3, ADR-082). Pure: every dependency is injected, so each rule can be exercised where it
 * can actually fail rather than only through a route on one deployment profile.
 *
 * **The sandbox data boundary is the reason this file is separate.** Milestone M-M authorises a
 * SYNTHETIC sandbox (LOCKED §4A.1). An import route that persists arbitrary identifiers — even as
 * unresolved rows — is a path for a real attribution file to land in Neon, in its backups and in its
 * exports, before the PHI-capable environment split (#267), the auth fork (#265) and observability
 * (#264) exist. So on a generated-corpus deployment an identifier outside the corpus namespace
 * REFUSES THE WHOLE UPLOAD before anything is written, naming the count and never the values; and on
 * a live-directory deployment the route is off entirely until the PHI phase supplies an authoritative
 * resolver.
 */
import type { SubjectListMember } from "../stores/subject-list-store.ts";

/** Hard ceiling on one upload. Above this the ACO is sending something other than an attributed list. */
export const MAX_IDENTIFIERS = 50_000;
/** Matches the `raw_identifier` CHECK in both schemas, so the validator and the database agree. */
export const MAX_IDENTIFIER_LENGTH = 128;
/** 2 MB of text is ~50,000 identifiers with room to spare; beyond it we refuse rather than buffer. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/**
 * The identifier shapes each deployment's OWN synthetic directory uses.
 *
 * **Both corpus spellings, and that is not a nicety.** The Maui corpus is 48 hand-written fixture
 * patients with three-digit ids (`pat-001`, `corpus-fixture-prefix.ts`) followed by generated ones
 * with five (`pat-00049`, `corpus-patient.ts`). A namespace test written for the generated form alone
 * would refuse the first 48 real patients in the sandbox — a gate that rejects the very data it
 * exists to admit, which is as broken as one that admits everything.
 *
 * **Per profile, because the default deployment is a different synthetic roster.** TWH's occupational
 * directory is `emp-001`; applying the corpus pattern there would refuse every legitimate identifier.
 * Both profiles are sandboxes, and the gate's job on each is the same: keep a REAL-WORLD identifier —
 * an MRN, an MBI, a name, an email — out of the database before #267/#265/#264 exist.
 *
 * These are NAMESPACE tests, not existence tests: `pat-99999` conforms and is simply NOT_FOUND, so
 * the review queue is still exercised with synthetic-shaped identifiers.
 */
export const SANDBOX_IDENTIFIER_PATTERNS = {
  maui: /^pat-\d{3,5}$/,
  default: /^emp-\d{3,5}$/,
} as const satisfies Record<string, RegExp>;

export function sandboxIdentifierPattern(profileId: string): RegExp {
  return profileId === "maui" ? SANDBOX_IDENTIFIER_PATTERNS.maui : SANDBOX_IDENTIFIER_PATTERNS.default;
}

export interface ParsedIdentifiers {
  /** Trimmed, blank-free, de-duplicated, in first-seen order. */
  identifiers: string[];
  duplicatesDropped: number;
}

export type ParseFailure =
  | { error: "invalid_request"; parameter: string; message: string }
  | { error: "payload_too_large"; message: string };

export type ParseResult = { ok: true; value: ParsedIdentifiers } | { ok: false; failure: ParseFailure };

/**
 * One identifier per line — deliberately NOT "a CSV".
 *
 * A file with columns needs a column choice, a header rule and an escaping rule, and getting any of
 * them wrong silently imports the wrong field: an attribution file whose second column is a name
 * would produce 50,000 NOT_FOUND rows that look like a matching failure rather than a parsing one.
 * So a line containing a comma is refused, with the line number, and the operator is told what the
 * format is. A leading BOM and CRLF endings are stripped, because a file exported from a spreadsheet
 * on Windows carries both and neither is the operator's mistake.
 */
export function parseIdentifierText(raw: string): ParseResult {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const seen = new Set<string>();
  const identifiers: string[] = [];
  let duplicatesDropped = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const value = lines[i]!.trim();
    if (!value) continue;
    if (value.includes(",")) {
      return {
        ok: false,
        failure: {
          error: "invalid_request",
          parameter: "identifiers",
          message: `line ${i + 1} contains a comma; send one identifier per line, not a CSV row`,
        },
      };
    }
    if (value.length > MAX_IDENTIFIER_LENGTH) {
      return {
        ok: false,
        failure: {
          error: "invalid_request",
          parameter: "identifiers",
          message: `line ${i + 1} is longer than ${MAX_IDENTIFIER_LENGTH} characters`,
        },
      };
    }
    if (seen.has(value)) {
      duplicatesDropped += 1;
      continue;
    }
    seen.add(value);
    identifiers.push(value);
  }
  return finish({ identifiers, duplicatesDropped });
}

/** The JSON body's `identifiers[]`, held to the same rules so the two formats cannot diverge. */
export function parseIdentifierArray(raw: unknown): ParseResult {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      failure: { error: "invalid_request", parameter: "identifiers", message: "identifiers must be an array of strings" },
    };
  }
  const seen = new Set<string>();
  const identifiers: string[] = [];
  let duplicatesDropped = 0;
  for (const entry of raw) {
    // Refused, never coerced: `String(12345)` would silently invent an identifier the file never
    // carried, and a number in an attribution column is exactly where a leading zero has been lost.
    if (typeof entry !== "string") {
      return {
        ok: false,
        failure: { error: "invalid_request", parameter: "identifiers", message: "every identifier must be a string" },
      };
    }
    const value = entry.trim();
    if (!value) continue;
    if (value.length > MAX_IDENTIFIER_LENGTH) {
      return {
        ok: false,
        failure: {
          error: "invalid_request",
          parameter: "identifiers",
          message: `an identifier is longer than ${MAX_IDENTIFIER_LENGTH} characters`,
        },
      };
    }
    if (seen.has(value)) {
      duplicatesDropped += 1;
      continue;
    }
    seen.add(value);
    identifiers.push(value);
  }
  return finish({ identifiers, duplicatesDropped });
}

function finish(value: ParsedIdentifiers): ParseResult {
  if (value.identifiers.length === 0) {
    return {
      ok: false,
      failure: { error: "invalid_request", parameter: "identifiers", message: "at least one identifier is required" },
    };
  }
  if (value.identifiers.length > MAX_IDENTIFIERS) {
    return {
      ok: false,
      failure: {
        error: "invalid_request",
        parameter: "identifiers",
        message: `at most ${MAX_IDENTIFIERS} identifiers per list; received ${value.identifiers.length}`,
      },
    };
  }
  return { ok: true, value };
}

/**
 * How many of these identifiers are outside the sandbox's own namespace.
 *
 * Returns a COUNT, never the offending values, and the route echoes the count alone: the whole point
 * of refusing is that the values must not be persisted, and putting them in an error body (which is
 * logged, and which a browser keeps) would persist them by another route.
 */
export function countOutsideSandboxNamespace(identifiers: readonly string[], pattern: RegExp): number {
  let n = 0;
  for (const id of identifiers) if (!pattern.test(id)) n += 1;
  return n;
}

/**
 * Turn identifiers into members.
 *
 * `resolve` is injected rather than reaching for the directory, for a reason the review of #567 made
 * concrete: the LIVE directory's `employeeById` FABRICATES a minimal profile for any `wc|`-prefixed
 * string (`live-directory.ts`), so a resolver built on it would auto-match identifiers that exist
 * nowhere. The caller passes a lookup over the ENUMERATED directory members, and a test hands this
 * function a fabricating lookup to prove it is never consulted.
 *
 * **The AMBIGUOUS branch cannot fire under today's exact-id matching** — two distinct identifiers
 * never resolve to one subject when the rule is string equality on `externalId`. It is written and
 * tested here anyway because this is the seam the identifier format changes at (name+DOB, MBI), and a
 * collapse discovered later would silently double a patient in every denominator the list feeds. The
 * partial unique index in both schemas is the second line of that defence.
 */
export function resolveMembers(
  identifiers: readonly string[],
  resolve: (rawIdentifier: string) => string | null,
): SubjectListMember[] {
  const claimed = new Set<string>();
  return identifiers.map((rawIdentifier) => {
    const subjectId = resolve(rawIdentifier);
    if (subjectId === null) return { rawIdentifier, subjectId: null, resolution: "NOT_FOUND" as const };
    if (claimed.has(subjectId)) return { rawIdentifier, subjectId: null, resolution: "AMBIGUOUS" as const };
    claimed.add(subjectId);
    return { rawIdentifier, subjectId, resolution: "MATCHED" as const };
  });
}

export interface ImportCounts {
  total: number;
  matched: number;
  notFound: number;
  ambiguous: number;
  duplicatesDropped: number;
}

export function countMembers(members: readonly SubjectListMember[], duplicatesDropped: number): ImportCounts {
  let matched = 0;
  let notFound = 0;
  let ambiguous = 0;
  for (const m of members) {
    if (m.resolution === "MATCHED") matched += 1;
    else if (m.resolution === "NOT_FOUND") notFound += 1;
    else ambiguous += 1;
  }
  return { total: members.length, matched, notFound, ambiguous, duplicatesDropped };
}

/**
 * Matched members grouped by payer code, so the Medicare-Advantage question is answerable from the
 * list itself rather than by re-running the report with a payer filter.
 *
 * The ACO's attribution is traditional Medicare; "All Medicare" in this product is codes 1 AND 11,
 * because the typology is hierarchical (DATA_MODEL_CONTRACTS §6.3). Whether the ACO's file includes
 * Medicare Advantage members is one of the four open questions, and until it is answered the honest
 * move is to show the split rather than assume one reading.
 */
export function payerBreakdown(
  members: readonly SubjectListMember[],
  payerOf: (subjectId: string) => string | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of members) {
    if (m.resolution !== "MATCHED" || m.subjectId === null) continue;
    const code = payerOf(m.subjectId) ?? "";
    if (!code) continue;
    out[code] = (out[code] ?? 0) + 1;
  }
  return out;
}
