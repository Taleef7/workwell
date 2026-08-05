/**
 * Reader for the `cqframework/cql-tests` XML corpus (V7 / issue #296).
 *
 * ## Why hand-rolled
 *
 * CLAUDE.md forbids new dependencies without approval, and Node has no DOM parser. The same constraint
 * produced `src/fhir/cda-parse.ts` for QRDA, and this input is far simpler: one schema, no namespaces to
 * resolve, no CDATA, four element types.
 *
 * ## The shape, measured rather than assumed (2026-08-05, pin 727219f)
 *
 * ```xml
 * <tests name="CqlArithmeticFunctionsTest" version="1.0">
 *   <capability code="arithmetic-operators"/>
 *   <group name="Abs" version="1.0">
 *     <capability code="arithmetic-operators"/>
 *     <test name="AbsNeg1" version="1.0">
 *       <capability code="system.long"/>
 *       <expression>Abs(-1)</expression>
 *       <output>1</output>
 *     </test>
 *   </group>
 * </tests>
 * ```
 *
 * Facts that corrected issue #296's description:
 *   - **`invalid` is an attribute of `<expression>`, not `<test>`** — 42 cases: 37 `true`, 3 `semantic`,
 *     2 `syntax`. #296 said `<test invalid=…>`, which matches nothing in the corpus.
 *   - `<output>` carries **no attributes**; the expected value is always element text.
 *   - `<capability>` appears at all three levels and is how the corpus expects a runner to skip.
 *   - 1,835 `<test>` elements across 16 files, not "~1,731".
 *
 * ## Totality
 *
 * Every failure mode returns a `ParseError` rather than fewer tests. A conformance harness that silently
 * parses 200 of 1,835 cases reports a high pass RATE and is worthless — that is the specific way this
 * file could be worse than useless, so an unreadable or empty file is an error, never an empty list.
 */

export interface CqlTestCase {
  file: string;
  group: string;
  name: string;
  /** Version the case was introduced at, when declared. */
  version?: string;
  expression: string;
  /** Absent for `invalid` cases — they declare no expected output. */
  output?: string;
  /** `true` | `semantic` | `syntax` — the expression is expected NOT to translate. */
  invalid?: string;
  /** Capability codes required by the file, the group and the test, merged. */
  capabilities: string[];
}

export class ParseError extends Error {}

/** The five predefined XML entities plus numeric references. No entity table to grow. */
export function decodeXmlText(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // `&amp;` LAST, so `&amp;lt;` decodes to the literal text `&lt;` and not to `<`.
    .replace(/&amp;/g, "&");
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_][\w.:-]*)\s*=\s*"([^"]*)"/g)) {
    out[m[1]!] = decodeXmlText(m[2]!);
  }
  return out;
}

/** Capability codes declared by `<capability code="…"/>` elements directly inside `xml`. */
function capabilitiesIn(xml: string): string[] {
  return [...xml.matchAll(/<capability\b([^>]*)\/?>/g)]
    .map((m) => attrs(m[1]!)["code"])
    .filter((c): c is string => typeof c === "string" && c.length > 0);
}

/** Text content of the first `<name>…</name>` in `xml`, decoded; `undefined` when absent. */
function child(xml: string, name: string): { text: string; attributes: Record<string, string> } | undefined {
  const open = new RegExp(`<${name}\\b([^>]*?)(/?)>`, "s").exec(xml);
  if (!open) return undefined;
  const attributes = attrs(open[1] ?? "");
  if (open[2] === "/") return { text: "", attributes }; // self-closing
  const after = xml.slice(open.index + open[0].length);
  const close = after.indexOf(`</${name}>`);
  if (close < 0) throw new ParseError(`<${name}> is never closed`);
  return { text: decodeXmlText(after.slice(0, close)), attributes };
}

/**
 * Parse one test file. `fileName` is carried into every case for reporting and for the per-file
 * non-degeneracy assertion the runner makes.
 */
export function parseTestFile(fileName: string, xml: string): CqlTestCase[] {
  if (!/<tests\b/.test(xml)) throw new ParseError(`${fileName}: no <tests> root — is this a test file?`);

  // File-level capabilities are the ones before the first <group>; anything after belongs to a group.
  const firstGroup = xml.search(/<group\b/);
  const fileCaps = capabilitiesIn(firstGroup < 0 ? xml : xml.slice(0, firstGroup));

  const cases: CqlTestCase[] = [];
  const groupRe = /<group\b([^>]*)>(.*?)<\/group>/gs;
  let sawGroup = false;

  for (const g of xml.matchAll(groupRe)) {
    sawGroup = true;
    const groupName = attrs(g[1]!)["name"] ?? "(unnamed group)";
    const groupBody = g[2]!;
    // A group's own capabilities are those outside any <test>.
    const groupCaps = capabilitiesIn(groupBody.replace(/<test\b.*?<\/test>/gs, ""));

    for (const t of groupBody.matchAll(/<test\b([^>]*)>(.*?)<\/test>/gs)) {
      const a = attrs(t[1]!);
      const body = t[2]!;
      const name = a["name"];
      if (!name) throw new ParseError(`${fileName}/${groupName}: a <test> has no name attribute`);

      const expression = child(body, "expression");
      if (!expression) throw new ParseError(`${fileName}/${groupName}/${name}: no <expression>`);
      const output = child(body, "output");
      const invalid = expression.attributes["invalid"];

      // A valid case with no expected output cannot be graded, and silently dropping it would inflate
      // the pass rate over a smaller denominator — the exact failure this parser exists to refuse.
      if (!invalid && !output) {
        throw new ParseError(`${fileName}/${groupName}/${name}: valid case with no <output> — ungradable`);
      }

      cases.push({
        file: fileName,
        group: groupName,
        name,
        ...(a["version"] ? { version: a["version"] } : {}),
        expression: expression.text.trim(),
        ...(output ? { output: output.text.trim() } : {}),
        ...(invalid ? { invalid } : {}),
        capabilities: [...new Set([...fileCaps, ...groupCaps, ...capabilitiesIn(body)])],
      });
    }
  }

  if (!sawGroup) throw new ParseError(`${fileName}: no <group> elements found`);
  if (cases.length === 0) throw new ParseError(`${fileName}: parsed 0 tests — the reader is broken`);
  return cases;
}
