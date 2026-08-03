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

/** Every `<recordTarget>` identifier a document carries, as stable `root|extension` keys. */
export function recordTargetIdentifiers(root: CdaNode | undefined): string[] {
  const patientRole = child(child(root, "recordTarget"), "patientRole");
  return childrenNamed(patientRole, "id")
    .filter((id) => id.attrs.root && id.attrs.extension)
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

/**
 * Merge a group's documents into one bundle.
 *
 * Resource ids are namespaced per source document: two documents about one person can legitimately carry
 * the same generated id, and a collision would silently drop half a split patient's data — which is the
 * exact failure this merge exists to prevent.
 */
function merge(
  members: Array<{ index: number; imported: Qrda1Import; identifiers: string[] }>,
): Omit<ResolvedSubject, "documentIndexes"> {
  // Deterministic and input-order independent: the smallest identifier key wins, and a document with no
  // identifiers at all is a group of one, so its own Patient is the only candidate.
  const canonical =
    [...members].sort((a, b) => {
      const [ka, kb] = [[...a.identifiers].sort().join(","), [...b.identifiers].sort().join(",")];
      return ka < kb ? -1 : ka > kb ? 1 : a.index - b.index;
    })[0] ?? members[0]!;

  const patients = members.map((m) => ({
    member: m,
    resource: m.imported.bundle.entry.find(
      (e) => (e.resource as { resourceType?: string })?.resourceType === "Patient",
    )?.resource as Record<string, unknown> | undefined,
  }));
  const chosen = patients.find((p) => p.member === canonical)?.resource;

  const demographicConflicts: Array<{ field: string; values: string[] }> = [];
  if (members.length > 1) {
    for (const [field, read] of [
      ["birthDate", (p: Record<string, unknown>) => String(p.birthDate ?? "")],
      ["gender", (p: Record<string, unknown>) => String(p.gender ?? "")],
      ["name", (p: Record<string, unknown>) => JSON.stringify(p.name ?? [])],
    ] as const) {
      const values = [...new Set(patients.map((p) => (p.resource ? read(p.resource) : "")))];
      if (values.length > 1) demographicConflicts.push({ field, values });
    }
  }

  const entry: Array<{ resource: unknown }> = chosen ? [{ resource: chosen }] : [];
  for (const m of members) {
    for (const e of m.imported.bundle.entry) {
      const resource = e.resource as { resourceType?: string; id?: string };
      if (resource?.resourceType === "Patient") continue;
      entry.push({ resource: { ...resource, id: `${m.index}-${resource?.id ?? entry.length}` } });
    }
  }

  return {
    subjectId: canonical.imported.patientId,
    bundle: { resourceType: "Bundle", type: "collection", entry },
    untranslatedTemplates: [...new Set(members.flatMap((m) => m.imported.untranslatedTemplates))],
    measureIdentifiers: [...new Set(members.flatMap((m) => m.imported.measureIdentifiers))],
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
  const members: Array<{ index: number; imported: Qrda1Import; identifiers: string[] }> = [];
  documents.forEach((xml, index) => {
    try {
      members.push({ index, imported: importQrda1Document(xml), identifiers: recordTargetIdentifiers(parseXml(xml) ?? undefined) });
    } catch (error) {
      failures.push({ index, message: String((error as Error)?.message ?? error) });
    }
  });

  const subjects = group(members.map((m) => m.identifiers)).map((indexes) => {
    const groupMembers = indexes.map((i) => members[i]!);
    return { ...merge(groupMembers), documentIndexes: groupMembers.map((m) => m.index) };
  });
  return { subjects, failures };
}
