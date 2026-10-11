/**
 * Resolving a BATCH of QRDA Category I documents to the people they describe.
 *
 * ## Why this exists at all
 *
 * `importQrda1Document` is one document → one subject, which is right for one document and wrong for a
 * submission. A sender's documents are not one-per-person: the same patient legitimately arrives as
 * several documents (an encounter summary here, a lab there), and a receiver that counted documents
 * would report more people than exist. Measured against Cypress's own C2 archives — which deliberately
 * split one patient's clinical data across two documents and append 1–3 demographically "augmented"
 * duplicates — 66 and 68 documents describe **64** people, 152 and 153 describe **150**
 * (`docs/evidence/CVU_CALCULATION_CHECK_SPIKE_2026-08-02.md` §13). A per-document import reports the
 * document count and fails on arithmetic before any measure logic runs.
 *
 * ## The rule is DETERMINISTIC and identifier-only, and that is a decision
 *
 * Documents are grouped when they share **any** `<recordTarget>` identifier — the same `(root,
 * extension)` pair — transitively. Nothing else. A document sharing no identifier with any other is its
 * own person, however similar its demographics look.
 *
 * That is ADR-022's rule ("deterministic candidate keys produce suggestions; EMPMI-grade probabilistic
 * matching is explicitly out of scope") applied one level down, and it was chosen on a measurement
 * rather than on principle alone: adding a name+birthdate pass for the identifier-less documents changes
 * **nothing** on any of the four Cypress archives (64/150 either way), because the patients Cypress ships
 * without a Medicare Beneficiary Identifier are never the ones it duplicates. A rule that buys no
 * accuracy and can merge two different people is not worth having.
 *
 * The consequence is stated rather than hidden: an augmented duplicate whose identifiers were ALSO
 * randomized would stay unmerged here, and the subject count would be too high. Cypress does not do that
 * (it randomizes one of first name, last name or birthdate, never the MBI), but a different sender might,
 * and then this needs a human-in-the-loop reconcile like `person_links` rather than a cleverer heuristic.
 *
 * ## Merging, and what it refuses to decide
 *
 * A group's clinical resources are unioned under ONE document's Patient. Which document wins is
 * deterministic (the smallest identifier key, so it does not depend on input order) — but where the
 * group's documents DISAGREE on demographics the conflict is REPORTED, never silently resolved. A
 * `birthDate` conflict is load-bearing: both routed measures gate their initial population on
 * `AgeInYearsAt(...)`, so picking one silently can move a person between age bands. Review of the C2
 * harness reproduced exactly that — a MATCH printed while a birthdate the sender supplied was discarded.
 */
import { importQrda1Document, type Qrda1Import } from "./qrda1-import.ts";
import { child, childrenNamed, parseXml, type CdaNode } from "./cda-parse.ts";

export interface ResolvedSubject {
  /** The subject id the outcome is persisted under — the canonical document's own patient id. */
  subjectId: string;
  /** Source documents, by their index in the input array. */
  documentIndexes: number[];
  /** The merged bundle, ready for the unchanged engine. */
  bundle: { resourceType: "Bundle"; type: "collection"; entry: Array<{ resource: unknown }> };
  /** Union of every source document's untranslated QDM templates. */
  untranslatedTemplates: string[];
  /**
   * Blood-pressure readings the source documents left unpaired, summed. Pairing happens per document
   * (LOCKED §4A.8), so a reading whose other half sits in another document stays unpaired.
   */
  unpairedBloodPressureReadings: number;
  /** Union of the measure identities the source documents reference. */
  measureIdentifiers: string[];
  /** Fields on which this person's documents disagree — reported, never resolved. */
  demographicConflicts: Array<{ field: string; values: string[] }>;
}

export interface Qrda1Resolution {
  subjects: ResolvedSubject[];
  /** Documents that could not be imported at all, by index, with the reason. */
  failures: Array<{ index: number; message: string }>;
}

/**
 * Every `<recordTarget>` identifier a document carries, as stable `root|extension` keys.
 *
 * A `nullFlavor` id is NOT an identifier: `<id root="..." extension="UNK" nullFlavor="UNK"/>` says the
 * sender does not know this patient's number, and two documents both saying so are not the same person.
 * Measured in review (#389): without this filter two different people carrying the same placeholder
 * merged into one subject, under-counting the population and unioning two people's clinical data.
 */
export function recordTargetIdentifiers(root: CdaNode | undefined): string[] {
  const patientRole = child(child(root, "recordTarget"), "patientRole");
  return childrenNamed(patientRole, "id")
    .filter((id) => id.attrs.root && id.attrs.extension && !id.attrs.nullFlavor)
    .map((id) => `${id.attrs.root}|${id.attrs.extension}`);
}

/** Union-find over the identifier graph — transitive by construction, so A~B and B~C merges all three. */
function group(identifiersPerDocument: string[][]): number[][] {
  const parent = identifiersPerDocument.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const owner = new Map<string, number>();
  identifiersPerDocument.forEach((identifiers, i) => {
    for (const identifier of identifiers) {
      const seen = owner.get(identifier);
      if (seen === undefined) owner.set(identifier, i);
      else union(i, seen);
    }
  });
  const groups = new Map<number, number[]>();
  identifiersPerDocument.forEach((_, i) => {
    const root = find(i);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(i);
  });
  return [...groups.values()];
}

/** A copy of `value` with every `reference` string found in `renamed` replaced by its new name. */
function withReferencesRenamed(value: unknown, renamed: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => withReferencesRenamed(v, renamed));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = key === "reference" && typeof v === "string" && renamed.has(v) ? renamed.get(v) : withReferencesRenamed(v, renamed);
  }
  return out;
}

/** JSON with object keys sorted, so two equal resources stringify the same whatever their key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * One person's clinical resources from several documents, as one list.
 *
 * - Ids are namespaced per document (`<document index>-<id>`): two documents can reuse a generated id.
 * - References inside a document are renamed with the ids they point at, since the libraries match a
 *   reference to its target by exact id.
 * - A resource an EARLIER document of this person already gave is dropped, and references to it point at
 *   the kept copy. A sender's duplicate documents repeat their clinical entries, and two copies of one
 *   visit are two visits to a measure that counts engagements, as CMS137 does. A repeat is the same
 *   SOURCE entry: the same asserted CDA identifier (assigning authority and id, carried as `identifier`),
 *   the same content, and references that point at the same facts. Two distinct events can map to
 *   identical content (two date-only visits of one type), and only the source's own identifier says they
 *   are one, so an entry with no asserted identifier is never matched on its own; a resource with no
 *   identity (an encounter's diagnosis) goes only with the entries that reference it. A document that
 *   states an entry twice keeps both: each fact keeps as many copies as the document that states it most
 *   often, so the result does not depend on the order the documents arrive in.
 */
export function mergeMemberResources(members: ReadonlyArray<{ index: number; resources: readonly unknown[] }>): unknown[] {
  const out: unknown[] = [];
  // fingerprint -> the kept copies so far, across documents. A fact keeps as many copies as the document
  // that states it most often, whatever order the documents arrive in.
  const keptByFact = new Map<string, string[]>();
  for (const m of members) {
    const resources = m.resources as Array<{ resourceType?: string; id?: string }>;
    const byRef = new Map<string, { resourceType?: string; id?: string }>();
    for (const r of resources) if (r?.id !== undefined) byRef.set(`${r.resourceType}/${r.id}`, r);
    // A resource's fact: its content WITHOUT its FHIR id, which the importer may have made from the entry's
    // position (the source's own id is in `identifier`), with each in-document reference replaced by the
    // fact of what it points at (references run Encounter -> Condition, so this terminates).
    const facts = new Map<unknown, string>();
    const factOf = (r: { resourceType?: string; id?: string }, depth = 0): string => {
      const known = facts.get(r);
      if (known !== undefined) return known;
      const resolve = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(resolve);
        if (value === null || typeof value !== "object") return value;
        const o: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
          const target = key === "reference" && typeof v === "string" ? byRef.get(v) : undefined;
          o[key] = target && depth < 8 ? `fact:${factOf(target, depth + 1)}` : resolve(v);
        }
        return o;
      };
      const { id: _positional, ...content } = r;
      const fact = canonicalJson(resolve(content));
      facts.set(r, fact);
      return fact;
    };
    const renamed = new Map<string, string>();
    const dropped = new Set<unknown>();
    const refOf = (r: { resourceType?: string; id?: string }) => `${r.resourceType}/${r.id}`;
    // The nth copy of a fact in this document repeats the nth copy an earlier document kept, if there is one.
    const seenHere = new Map<string, number>();
    const dropAsRepeat = (r: { resourceType?: string; id?: string }): void => {
      const fact = factOf(r);
      const n = seenHere.get(fact) ?? 0;
      seenHere.set(fact, n + 1);
      const kept = keptByFact.get(fact) ?? [];
      if (n >= kept.length) return;
      renamed.set(refOf(r), kept[n]!);
      dropped.add(r);
    };
    // Only an entry the SOURCE identified (a CDA `<id>` with its assigning authority, carried as
    // `identifier`) can be a repeat of an earlier document's entry. An id the importer made up from an
    // entry's position says nothing about which event it is, so such a resource is never matched on its own.
    const identified = (r: { identifier?: unknown }) => Array.isArray(r.identifier) && r.identifier.length > 0;
    for (const r of resources) if (r?.id !== undefined && identified(r as { identifier?: unknown })) dropAsRepeat(r);
    // A resource with no identity of its own (an encounter's diagnosis Condition) goes with the entries that
    // name it: it is dropped only when every resource in this document that references it was dropped as a
    // repeat, and an earlier document kept the same one.
    const referencedBy = new Map<string, unknown[]>();
    const collectReferences = (owner: unknown, value: unknown): void => {
      if (Array.isArray(value)) return value.forEach((v) => collectReferences(owner, v));
      if (value === null || typeof value !== "object") return;
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (key === "reference" && typeof v === "string" && byRef.has(v)) (referencedBy.get(v) ?? referencedBy.set(v, []).get(v)!).push(owner);
        else collectReferences(owner, v);
      }
    };
    for (const r of resources) collectReferences(r, r);
    for (const r of resources) {
      if (r?.id === undefined || identified(r as { identifier?: unknown })) continue;
      const owners = referencedBy.get(refOf(r)) ?? [];
      if (owners.length > 0 && owners.every((o) => dropped.has(o))) dropAsRepeat(r);
    }
    const keptHere = new Map<string, string[]>();
    for (const r of resources) {
      if (r?.id === undefined || dropped.has(r)) continue;
      const fresh = `${r.resourceType}/${m.index}-${r.id}`;
      renamed.set(refOf(r), fresh);
      const fact = factOf(r);
      (keptHere.get(fact) ?? keptHere.set(fact, []).get(fact)!).push(fresh);
    }
    resources.forEach((r, i) => {
      if (dropped.has(r)) return;
      const rewritten = withReferencesRenamed(r, renamed) as Record<string, unknown>;
      out.push({ ...rewritten, id: `${m.index}-${r?.id ?? i}` });
    });
    for (const [fact, refs] of keptHere) keptByFact.set(fact, [...(keptByFact.get(fact) ?? []), ...refs]);
  }
  return out;
}

/**
 * Merge a group's documents into one bundle.
 *
 * Resource ids are namespaced per source document: two documents about one person can legitimately carry
 * the same generated id, and a collision would silently drop half a split patient's data — which is the
 * exact failure this merge exists to prevent. `mergeMemberResources` does that, keeps references intact,
 * and merges a source entry (same CDA identifier and content) that a person's documents repeat.
 */
function merge(
  members: Array<{ index: number; imported: Qrda1Import; identifiers: string[]; documentId?: string; text: string }>,
): Omit<ResolvedSubject, "documentIndexes"> {
  // Deterministic and input-order independent — INCLUDING the ordinary case where every member carries
  // the same identifiers, which is what one sender splitting a patient across documents produces. An
  // earlier cut tiebroke on input index there, so a birthdate disagreement was resolved by `readdirSync`
  // order: measured in review (#389) at a 28-year swing across `AgeInYearsAt` bands depending on which
  // way the array was read, under a doc comment claiming order independence. The tiebreak is now the
  // document's own id, then its patient id, then the document TEXT — all content, none of it position.
  // The text is the last resort and it earns its place: two documents can legitimately share every
  // identifier AND carry no document id (one sender, one patient, two records), and that is exactly the
  // case where a birthdate disagreement would otherwise be settled by array order.
  const sortKey = (m: { identifiers: string[]; documentId?: string; imported: Qrda1Import; text: string }) =>
    `${[...m.identifiers].sort().join(",")}|${m.documentId ?? ""}|${m.imported.patientId}|${m.text}`;
  const canonical =
    [...members].sort((a, b) => {
      const [ka, kb] = [sortKey(a), sortKey(b)];
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })[0] ?? members[0]!;

  const patients = members.map((m) => ({
    member: m,
    resource: m.imported.bundle.entry.find(
      (e) => (e.resource as { resourceType?: string })?.resourceType === "Patient",
    )?.resource as Record<string, unknown> | undefined,
  }));
  const chosen = patients.find((p) => p.member === canonical)?.resource;

  // ABSENCE IS NOT DISAGREEMENT, and taking the canonical Patient whole conflates them. Measured in
  // review (#389): where only a NON-canonical document carried `us-core-sex`, the merged Patient had
  // none — and official CMS125's initial population reads that extension and nothing else (ADR-042), so
  // the person silently left the initial population while the report called it a `gender` "conflict" of
  // `["", "female"]`. So: the canonical value wins where two members both state one, a field the
  // canonical is SILENT about is filled from whichever member states it, and a conflict is recorded only
  // for real disagreement. `extension` and `identifier` are compared too — the earlier version read
  // three fields and `us-core-sex` is in none of them.
  const demographicConflicts: Array<{ field: string; values: string[] }> = [];
  const patient: Record<string, unknown> = { ...(chosen ?? {}) };
  for (const field of ["birthDate", "gender", "name", "extension", "identifier"]) {
    const stated = patients
      .map((p) => p.resource?.[field])
      .filter((v) => v !== undefined && v !== null && v !== "");
    const distinct = [...new Set(stated.map((v) => JSON.stringify(v)))];
    if (members.length > 1 && distinct.length > 1) demographicConflicts.push({ field, values: distinct });
    if (patient[field] === undefined && stated.length > 0) patient[field] = stated[0];
  }

  const entry: Array<{ resource: unknown }> = chosen ? [{ resource: patient }] : [];
  const clinical = mergeMemberResources(
    members.map((m) => ({
      index: m.index,
      resources: m.imported.bundle.entry
        .map((e) => e.resource)
        .filter((r) => (r as { resourceType?: string })?.resourceType !== "Patient"),
    })),
  );
  for (const resource of clinical) entry.push({ resource });

  return {
    subjectId: canonical.imported.patientId,
    bundle: { resourceType: "Bundle", type: "collection", entry },
    untranslatedTemplates: [...new Set(members.flatMap((m) => m.imported.untranslatedTemplates))],
    unpairedBloodPressureReadings: members.reduce((n, m) => n + m.imported.unpairedBloodPressureReadings, 0),
    // BOTH identity kinds, exactly as `/evaluate` checks them. Dropping `localMeasureId` left an
    // authored-measure export — which carries `urn:workwell:measure` and no published identifier — with
    // nothing to check against, so re-importing one under the WRONG authored measure passed silently on
    // this route while `/evaluate` refused the same document (review, #389).
    measureIdentifiers: [
      ...new Set(
        members.flatMap((m) => [
          ...m.imported.measureIdentifiers,
          ...(m.imported.localMeasureId ? [m.imported.localMeasureId] : []),
        ]),
      ),
    ],
    demographicConflicts,
  };
}

/**
 * Import a batch of QRDA Category I documents and resolve them to subjects.
 *
 * A document that cannot be imported is REPORTED rather than dropped or fatal: one unreadable document
 * in a submission of 150 should not cost the other 149, and a receiver that silently ignored it would
 * under-report the population by one person with nothing to show for it. (Measured: Cypress's own
 * archives contain such a document — the half of a clinically split patient that received no clinical
 * data at all, which ADR-051 refuses. Its person is recovered from the other half.)
 */
export function resolveQrda1Documents(documents: readonly string[]): Qrda1Resolution {
  const failures: Array<{ index: number; message: string }> = [];
  const members: Array<{ index: number; imported: Qrda1Import; identifiers: string[]; documentId?: string; text: string }> = [];
  documents.forEach((xml, index) => {
    try {
      const root = parseXml(xml) ?? undefined;
      const documentId = child(root, "id")?.attrs.root;
      members.push({
        index,
        imported: importQrda1Document(xml),
        identifiers: recordTargetIdentifiers(root),
        text: xml,
        ...(documentId ? { documentId } : {}),
      });
    } catch (error) {
      failures.push({ index, message: String((error as Error)?.message ?? error) });
    }
  });

  const subjects = group(members.map((m) => m.identifiers)).map((indexes) => {
    const groupMembers = indexes.map((i) => members[i]!);
    return { ...merge(groupMembers), documentIndexes: groupMembers.map((m) => m.index) };
  });
  // Grouping is root-AWARE; `importQrda1Document`'s patient id is deliberately root-AGNOSTIC (the first
  // `<id>` carrying an extension, whatever the root) and falls back to a constant. So two documents that
  // grouping correctly keeps APART — the same extension under different roots, or no extension at all —
  // can still resolve to the same subject id, and nothing downstream would notice: `outcomes` has no
  // unique key on `(run_id, subject_id)`, so both rows persist, the population arithmetic survives, and
  // every per-subject read (`listOutcomesForEmployee`, the QRDA I export's `indexBundlesBySubject`, the
  // per-subject MeasureReport, the roster) attributes one person's data to another. Measured in review
  // (#389). Disambiguated rather than refused: the documents are fine, our id derivation is lossy, and a
  // suffix keeps both people countable and distinguishable.
  const seen = new Map<string, number>();
  for (const subject of subjects) {
    const count = (seen.get(subject.subjectId) ?? 0) + 1;
    seen.set(subject.subjectId, count);
    if (count > 1) subject.subjectId = `${subject.subjectId}~${count}`;
  }
  return { subjects, failures };
}
