/**
 * A minimal UCUM unit VALIDATOR — the one the CQL translator uses, everywhere it runs.
 *
 * ## Why this exists at all — a finding, not a formality
 *
 * `LibraryManager(modelManager, options, cache, lazyUcumService, …)` takes the UCUM service as its
 * FOURTH argument and defaults to one that **throws** `No default UCUM service available`. So a
 * translator built without one cannot compile any CQL containing a quantity literal — `5 'mg'`,
 * `1.0'cm'`, any `Quantity` comparison.
 *
 * That was live in production until 2026-08-05 (#397): the Studio's ELM Explorer recompiles as you type,
 * so an author writing perfectly valid unit-bearing CQL got an error naming a missing service rather than
 * anything about their code. It went unnoticed because no committed measure uses a unit — the defect was
 * invisible to every test and to `pnpm compile-measures` alike, and surfaced only when the V7 conformance
 * harness (#296 / ADR-060) ran CQL somebody else wrote. **It accounted for 155 of that run's 183 apparent
 * translation errors**, and publishing 183 as "the JS translator delta" would have been badly wrong.
 *
 * `createUcumService(convertUnit, validateUnit)` builds the service from two callbacks — and probing
 * showed the translator calls **`validateUnit` only**; conversion happens at runtime inside
 * `cql-execution`, which carries its own UCUM support. So validation is the whole contract.
 *
 * ## One validator, three call sites
 *
 * The runtime translator (`cql-translator.ts` → the ELM Explorer), the build-time compiler
 * (`scripts/compile-measures.mjs`) and the conformance harness all use this module. They must agree:
 * a measure that compiles at build time and fails in the authoring UI — or the reverse — is a defect
 * whose cause is invisible from either side.
 *
 * ## Why not "return valid for everything"
 *
 * Because then a genuinely malformed unit would translate cleanly, and any corpus case that expects a bad
 * unit to be REJECTED would silently flip from a correct refusal to a wrong acceptance — manufacturing a
 * pass. A permissive stub is the cheap option that quietly corrupts the measurement it is here to enable.
 *
 * ## Scope, stated
 *
 * This validates the UCUM *grammar* plus a table of atoms and prefixes — enough to be honest, not a
 * complete UCUM implementation. An unrecognized atom is reported as invalid rather than waved through; if
 * that ever rejects something legitimate, the fix is to add the atom here with the case that needed it.
 *
 * **That trade-off is deliberate now that this gates authoring**, and it errs the safe way. Rejecting a
 * legitimate unit is a visible complaint an author reports; accepting a malformed one lets bad CQL through
 * the authoring gate and surfaces later as a wrong number. A full UCUM implementation is a dependency
 * (`@lhncbc/ucum-lit` and friends), and CLAUDE.md's no-new-dependencies rule makes that an owner call —
 * so the honest table is the choice, with its limits written down rather than implied.
 *
 * **A first draft said "the corpus uses six distinct units". It uses at least 18** — `mg`, `ml`,
 * `[lb_av]`, `a`, `d`, `h`, `min`, `mo`, `ms`, `s`, `wk` and `{eskimo_kisses}` among them (review, #398).
 * The table covers all of them, and zero of the run's translation errors are UCUM-caused, so the
 * measurement was never affected — but a stated scope that is off by 3× in the file whose whole argument
 * is "the table is generous relative to what is exercised" is exactly the kind of asserted-not-derived
 * claim this codebase keeps catching. `harness.test.ts` now WALKS the corpus and asserts every quantity
 * unit in it validates, so the claim maintains itself instead of needing to be believed.
 */

/** UCUM prefix symbols (case-sensitive, as UCUM requires), longest first so `da` beats `d`. */
const PREFIXES = ["da", "Y", "Z", "E", "P", "T", "G", "M", "k", "h", "d", "c", "m", "u", "n", "p", "f", "a", "z", "y"];

/**
 * **Metric** atoms — the only ones a prefix may attach to (UCUM §11: prefixes combine with metric units
 * alone). Splitting the table this way is what stops `m[lb_av]` from validating: `[lb_av]` is a real atom
 * and `m` is a real prefix, but an avoirdupois pound is not metric, so "millipound" is not a unit
 * (Codex review, #402).
 */
const METRIC_ATOMS = new Set([
  // base + derived SI
  "m", "s", "g", "rad", "K", "C", "cd", "mol",
  "L", "l", "Hz", "N", "Pa", "J", "W", "A", "V", "F", "Ohm", "S", "Wb", "T", "H", "lm", "lx", "Bq", "Gy", "Sv",
  // clinical / lab, all metric in UCUM
  "U", "eq", "osm", "kat", "Cel", "bar", "[iU]", "[IU]",
  // `m[Hg]` is the metric atom; `mm[Hg]` is milli + m[Hg]. Plain `mmHg` is NOT a UCUM symbol and is
  // deliberately absent — accepting it would be the false acceptance this module exists to avoid.
  "m[Hg]", "m[H2O]",
]);

/**
 * **Non-metric** atoms — valid on their own, never with a prefix. Time units above the second are the
 * common surprise: `s` is metric, `min`/`h`/`d`/`wk`/`mo`/`a` are not.
 */
const NON_METRIC_ATOMS = new Set([
  "min", "h", "d", "wk", "mo", "a",
  "atm", "[in_i]", "[ft_i]", "[lb_av]", "[oz_av]", "[degF]",
  "[pH]", "[ppm]", "[ppb]", "%",
  "1",
]);

/** `{anything}` is a UCUM annotation: legal after a unit, or standing alone as a dimensionless label. */
const ANNOTATION = /\{[^{}]*\}/g;

function validAtom(sym: string): boolean {
  if (METRIC_ATOMS.has(sym) || NON_METRIC_ATOMS.has(sym)) return true;
  // Longest-prefix-first, so `da` is tried before `d` and `mol` is not read as `m` + `ol`.
  // Only METRIC atoms are prefixable.
  for (const p of PREFIXES) {
    if (sym.startsWith(p) && METRIC_ATOMS.has(sym.slice(p.length))) return true;
  }
  return false;
}

/**
 * Splits a term on its TOP-LEVEL `.` and `/` operators, leaving parenthesised subterms and annotations
 * intact. `null` means the parentheses or braces do not balance.
 *
 * Splitting with a plain regex — as the first version did — turns `mg/(kg.d)` into `["mg", "(kg", "d)"]`
 * and rejects a perfectly ordinary dose rate (Codex review, #402). That is a false REJECTION, the
 * failure mode this module claims to prefer but which still blocks an author for no reason.
 */
function splitTopLevel(term: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let inAnnotation = false;
  let current = "";
  for (const ch of term) {
    if (inAnnotation) {
      current += ch;
      if (ch === "}") inAnnotation = false;
      else if (ch === "{") return null; // nested braces are not UCUM
      continue;
    }
    if (ch === "{") { inAnnotation = true; current += ch; continue; }
    if (ch === "}") return null; // unopened
    if (ch === "(") { depth += 1; current += ch; continue; }
    if (ch === ")") { depth -= 1; if (depth < 0) return null; current += ch; continue; }
    if ((ch === "." || ch === "/") && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  if (depth !== 0 || inAnnotation) return null;
  parts.push(current);
  return parts;
}

/** A `(...)` group whose parenthesis closes only at the very end — i.e. the whole component is one group. */
function wholeGroup(c: string): string | null {
  if (!c.startsWith("(")) return null;
  let depth = 0;
  for (let i = 0; i < c.length; i += 1) {
    if (c[i] === "(") depth += 1;
    else if (c[i] === ")") {
      depth -= 1;
      if (depth === 0) return i === c.length - 1 ? c.slice(1, -1) : null;
    }
  }
  return null;
}

/** One component: a parenthesised term, an annotation, a numeric factor, or an atom with an exponent. */
function validComponent(c: string): boolean {
  if (c === "") return false;

  const inner = wholeGroup(c);
  if (inner !== null) return validTerm(inner);

  // Annotations carry no dimension. `mg{total}` is `mg`; `{tablet}` alone is dimensionless-but-valid.
  const stripped = c.replace(ANNOTATION, "");
  if (stripped === "") return true;
  if (stripped === "1") return true;
  // Numeric factor, e.g. `10*3` or a bare integer.
  if (/^\d+(\*[+-]?\d+)?$/.test(stripped)) return true;
  const m = /^([^\d+-]+)([+-]?\d+)?$/.exec(stripped);
  if (!m) return false;
  return validAtom(m[1]!);
}

/**
 * A UCUM term: components joined by `.` and `/`.
 *
 * **Repeated `/` is legal**, contrary to one review comment: the UCUM grammar is
 * `<term> ::= <term> "." <component> | <term> "/" <component> | <component>`, which is left-recursive,
 * so `mg/kg/d` parses as `(mg/kg)/d`.
 *
 * A leading `/` is NOT handled here. UCUM puts it on the outermost production only —
 * `<main-term> ::= "/" <term> | <term>` — so `/min` is a unit while `mg/()` is not. Applying the
 * allowance recursively (the first cut) accepted the empty group, which a test caught.
 */
function validTerm(term: string): boolean {
  if (term === "") return false;
  const parts = splitTopLevel(term);
  if (parts === null) return false;
  return parts.every((p) => validComponent(p));
}

/**
 * Returns `null` when `unit` is a valid UCUM expression, else a message.
 *
 * The `null`-means-valid convention is the translator's, learned by probing `createUcumService`, not one
 * chosen here.
 */
export function validateUnit(unit: string): string | null {
  // Trimming the OUTSIDE is our own hygiene; whitespace INSIDE is the author's error. UCUM codes contain
  // no whitespace at all, and the previous version trimmed each component — which quietly accepted
  // `mg / dL` (Codex review, #402). That is a false ACCEPTANCE, the direction this module claims not to
  // fail in, so it is the more serious of the two shapes.
  const u = (unit ?? "").trim();
  if (u === "") return "empty unit";
  if (/\s/.test(u)) return `'${unit}' is not a valid UCUM unit (UCUM codes contain no whitespace)`;

  // `<main-term> ::= "/" <term> | <term>` — a leading solidus is the outermost production only, which is
  // why `/min` is a unit and `mg/()` is not.
  const term = u.startsWith("/") ? u.slice(1) : u;
  if (!validTerm(term)) return `'${unit}' is not a valid UCUM unit`;
  return null;
}

/**
 * Conversion is never requested during translation — probing showed only `validateUnit` is called, and
 * `cql-execution` does its own conversion at runtime. This exists to satisfy the two-callback signature
 * and REFUSES rather than guessing: a silent wrong factor would corrupt results invisibly, which is worse
 * than an error nobody sees because nobody calls it.
 */
export function convertUnit(value: number, from: string, to: string): number {
  if (from === to) return value;
  throw new Error(
    `this translator does not implement UCUM conversion (${from} → ${to}); ` +
      `translation never requests it and cql-execution converts at runtime`,
  );
}
