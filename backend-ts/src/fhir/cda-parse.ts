/**
 * A minimal XML reader for CDA documents — enough to read QRDA, and nothing more.
 *
 * ## Why hand-rolled
 *
 * CLAUDE.md forbids new dependencies without explicit approval, and Node ships no DOM parser. The
 * emitters in this directory are hand-built for the same reason, so the reader matches their posture:
 * small, total, and tested against the documents we actually emit plus the CMS sample files.
 *
 * ## What it deliberately does NOT do
 *
 * No DTD, no entity declarations, no namespace resolution, no XPath, no validation. Element names are
 * kept **verbatim including any prefix**, and lookups match on the local name, because CDA documents in
 * the wild appear both as `<ClinicalDocument xmlns="urn:hl7-org:v3">` and as `<cda:ClinicalDocument>`.
 * That is a deliberate simplification, not an oversight: a document that binds `cda:` to something other
 * than the HL7 v3 namespace would be misread — and such a document is not a QRDA.
 *
 * ## Untrusted input
 *
 * This parses third-party uploads, so every branch is total: malformed markup yields the tree parsed so
 * far rather than an exception, and there is no construct that can cause unbounded work. In particular
 * there is no entity expansion at all, so the billion-laughs class does not exist here — the five
 * predefined entities are the only ones decoded, and `&anything;` else is left as literal text.
 */

export interface CdaNode {
  /** Element name as written, prefix included (`ClinicalDocument`, `cda:section`). */
  readonly name: string;
  /** Local name — the part after any `:`. What every lookup below matches on. */
  readonly local: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly CdaNode[];
  /** Direct text content, entity-decoded and whitespace-collapsed. */
  readonly text: string;
}

const PREDEFINED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decode the five predefined entities and numeric character references.
 *
 * Nothing else is expanded. An undeclared `&foo;` stays literal rather than throwing or resolving —
 * this reader has no entity table for an attacker to grow.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x") || body.startsWith("#X") ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return PREDEFINED[body] ?? whole;
  });
}

interface MutableNode {
  name: string;
  local: string;
  attrs: Record<string, string>;
  children: MutableNode[];
  text: string;
}

const ATTR = /([A-Za-z_:][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(raw)) !== null) attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? "");
  return attrs;
}

/**
 * Parse an XML document into a tree. Returns the root element, or null if there is none.
 *
 * Comments, processing instructions, DOCTYPE and CDATA sections are handled; CDATA content becomes
 * literal text (undecoded, which is what CDATA means).
 */
export function parseXml(xml: string): CdaNode | null {
  const stack: MutableNode[] = [];
  let root: MutableNode | null = null;
  let i = 0;

  const addText = (raw: string) => {
    const open = stack[stack.length - 1];
    if (!open || raw === "") return;
    const decoded = decodeEntities(raw).replace(/\s+/g, " ");
    if (decoded.trim() === "") return;
    open.text = open.text === "" ? decoded.trim() : `${open.text} ${decoded.trim()}`;
  };

  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      addText(xml.slice(i));
      break;
    }
    addText(xml.slice(i, lt));

    // Comments, CDATA, DOCTYPE and processing instructions — skipped, except CDATA whose body is text.
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const body = xml.slice(lt + 9, end === -1 ? xml.length : end);
      const open = stack[stack.length - 1];
      if (open && body.trim() !== "") open.text = open.text === "" ? body.trim() : `${open.text} ${body.trim()}`;
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt);
      i = end === -1 ? xml.length : end + 1;
      continue;
    }

    const gt = xml.indexOf(">", lt);
    if (gt === -1) break; // truncated markup — keep what we have
    const inner = xml.slice(lt + 1, gt);
    i = gt + 1;

    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      // Pop to the matching open element. A stray close tag is ignored rather than corrupting the tree.
      for (let d = stack.length - 1; d >= 0; d--) {
        if (stack[d]!.name === name) {
          stack.length = d;
          break;
        }
      }
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^([A-Za-z_:][\w.:-]*)/.exec(body);
    if (!nameMatch) continue;
    const name = nameMatch[1]!;
    const node: MutableNode = {
      name,
      local: name.includes(":") ? name.slice(name.indexOf(":") + 1) : name,
      attrs: parseAttrs(body.slice(name.length)),
      children: [],
      text: "",
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (!root) root = node;
    if (!selfClosing) stack.push(node);
  }

  return root as CdaNode | null;
}

/** Direct children with this local name. */
export function childrenNamed(node: CdaNode | undefined, local: string): CdaNode[] {
  return (node?.children ?? []).filter((c) => c.local === local);
}

/** The first direct child with this local name. */
export function child(node: CdaNode | undefined, local: string): CdaNode | undefined {
  return (node?.children ?? []).find((c) => c.local === local);
}

/** Every descendant with this local name, depth-first, including the node itself. */
export function descendants(node: CdaNode | undefined, local: string): CdaNode[] {
  if (!node) return [];
  const out: CdaNode[] = [];
  const walk = (n: CdaNode) => {
    if (n.local === local) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

/**
 * True when this element declares the given templateId root (and extension, if given).
 *
 * The extension is checked only when asked for, because QRDA elements routinely carry the same root at
 * several versions and a caller usually means "whatever version of this template".
 */
export function hasTemplate(node: CdaNode | undefined, root: string, extension?: string): boolean {
  return childrenNamed(node, "templateId").some(
    (t) => t.attrs.root === root && (extension === undefined || t.attrs.extension === extension),
  );
}
