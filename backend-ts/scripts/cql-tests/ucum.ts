/**
 * A minimal UCUM unit VALIDATOR for the conformance harness.
 *
 * ## Why this exists at all — a finding, not a formality
 *
 * The first full run reported **183 translation errors, and 155 of them were the single message
 * `No default UCUM service available`** — i.e. our harness, not the JS translator, was rejecting every
 * expression containing a quantity. Publishing that 183 as "the JS translator delta" would have been
 * badly wrong, which is exactly what the plan's harness-vs-engine check existed to catch.
 *
 * `LibraryManager(modelManager, options, cache, lazyUcumService, …)` takes the service as its FOURTH
 * argument and defaults to one that throws. `createUcumService(convertUnit, validateUnit)` builds it from
 * two callbacks — and probing showed the translator calls **`validateUnit` only**; conversion happens at
 * runtime inside `cql-execution`, which carries its own UCUM support. So validation is the whole contract.
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
 * complete UCUM implementation. The corpus uses six distinct units (`cm`, `g`, `m`, `g/cm3`, `cm2`, `1`),
 * so the table is generous relative to what is exercised. An unrecognized atom is reported as invalid
 * rather than waved through; if that ever rejects something legitimate, the fix is to add the atom here
 * with the case that needed it.
 */

/** UCUM prefix symbols (case-sensitive, as UCUM requires). */
const PREFIXES = [
  "Y", "Z", "E", "P", "T", "G", "M", "k", "h", "da",
  "d", "c", "m", "u", "n", "p", "f", "a", "z", "y",
];

/**
 * UCUM atom symbols. Deliberately broader than the corpus needs — clinical quantities that show up in
 * real measure CQL are included so this module is reusable beyond the conformance run.
 */
const ATOMS = new Set([
  // base + common SI
  "m", "s", "g", "rad", "K", "C", "cd", "mol",
  "L", "l", "Hz", "N", "Pa", "J", "W", "A", "V", "F", "Ohm", "S", "Wb", "T", "H", "lm", "lx", "Bq", "Gy", "Sv",
  // time
  "min", "h", "d", "wk", "mo", "a", "ms",
  // clinical / lab
  "U", "IU", "eq", "osm", "pH", "kat", "Cel", "bar", "atm",
  "mmHg", "m[Hg]", "[in_i]", "[ft_i]", "[lb_av]", "[oz_av]", "[degF]",
  "[iU]", "[IU]", "[pH]", "[ppm]", "[ppb]", "%",
  // dimensionless
  "1",
]);

/** `{anything}` is a UCUM annotation and is always legal after a term (or standing alone). */
const ANNOTATION = /\{[^{}]*\}/g;

function validAtom(sym: string): boolean {
  if (ATOMS.has(sym)) return true;
  // Longest-prefix-first, so `da` is tried before `d` and `mol` is not read as `m` + `ol`.
  for (const p of [...PREFIXES].sort((a, b) => b.length - a.length)) {
    if (sym.startsWith(p) && ATOMS.has(sym.slice(p.length))) return true;
  }
  return false;
}

/** One component: an optional atom with an optional integer exponent, e.g. `cm3`, `s-1`, `10*3`. */
function validComponent(raw: string): boolean {
  const c = raw.trim();
  if (c === "") return false;
  if (c === "1") return true;
  // Numeric factor, e.g. `10*3` or a bare integer.
  if (/^\d+(\*[+-]?\d+)?$/.test(c)) return true;
  const m = /^([^\d+-]+)([+-]?\d+)?$/.exec(c);
  if (!m) return false;
  return validAtom(m[1]!);
}

/**
 * Returns `null` when `unit` is a valid UCUM expression, else a message.
 *
 * The `null`-means-valid convention is the translator's, learned by probing `createUcumService`, not one
 * chosen here.
 */
export function validateUnit(unit: string): string | null {
  const u = (unit ?? "").trim();
  if (u === "") return "empty unit";

  // Annotations carry no dimension — strip them, but a unit that is ONLY an annotation is valid.
  const stripped = u.replace(ANNOTATION, "");
  if (stripped === "") return null;

  for (const component of stripped.split(/[./]/)) {
    if (!validComponent(component)) {
      return `'${unit}' is not a valid UCUM unit (component '${component.trim()}' is unrecognized)`;
    }
  }
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
    `the conformance harness does not implement UCUM conversion (${from} → ${to}); ` +
      `translation never requests it and cql-execution converts at runtime`,
  );
}
