/**
 * QRDA Category I → FHIR R4 — the "import" half of §170.315(c)(2) "import and calculate" (M-B).
 *
 * ## Why this is the shape of the criterion
 *
 * (c)(2) requires a Health IT Module to **import a QRDA Category I file and compute the measure from
 * it**. That is only meaningful because Category I carries patient DATA rather than an answer (ADR-050):
 * the receiving engine recalculates. This module turns the QDM entries back into the FHIR the engine
 * already evaluates, so "calculate" is the existing, unchanged evaluation path — not a second engine.
 *
 * ## Exactly inverts `qdm-entries.ts`
 *
 * The two are a matched pair and a **round trip is the strongest test available**, since both halves are
 * ours: export a bundle, import the document, and the clinically load-bearing fields must survive. What
 * a round trip cannot prove is that our reading of the IG is right — only Cypress CVU+ can, and it has
 * not run. Nothing here may be described as certified.
 *
 * ## What it refuses rather than guesses
 *
 * A document that is not a QRDA Category I, or whose Patient Data section is empty, is **rejected**. An
 * empty section is precisely the non-conformant state our own exporter marks (CONF:67-14567) and
 * importing it would produce a bundle that computes an out-of-population answer for every measure —
 * indistinguishable from a genuinely ineligible patient, which is the hazard ADR-043 exists for.
 */
import { child, childrenNamed, descendants, hasTemplate, parseXml, type CdaNode } from "./cda-parse.ts";

/** OID → FHIR system URL. The inverse of `qdm-entries.ts`'s `CODE_SYSTEMS`. */
const SYSTEM_FOR_OID: Record<string, string> = {
  "2.16.840.1.113883.6.96": "http://snomed.info/sct",
  "2.16.840.1.113883.6.1": "http://loinc.org",
  "2.16.840.1.113883.6.12": "http://www.ama-assn.org/go/cpt",
  "2.16.840.1.113883.6.90": "http://hl7.org/fhir/sid/icd-10-cm",
  "2.16.840.1.113883.6.103": "http://hl7.org/fhir/sid/icd-9-cm",
  "2.16.840.1.113883.6.285": "urn:oid:2.16.840.1.113883.6.285",
};

/** QDM template roots this importer understands, keyed to what they become in FHIR. */
const T = {
  encounterPerformed: "2.16.840.1.113883.10.20.24.3.23",
  diagnosis: "2.16.840.1.113883.10.20.24.3.135",
  labPerformed: "2.16.840.1.113883.10.20.24.3.38",
  studyPerformed: "2.16.840.1.113883.10.20.24.3.18",
  procedurePerformed: "2.16.840.1.113883.10.20.24.3.64",
  result: "2.16.840.1.113883.10.20.24.3.87",
  patientDataSection: "2.16.840.1.113883.10.20.24.2.1",
  measureSection: "2.16.840.1.113883.10.20.24.2.2",
  eMeasureReference: "2.16.840.1.113883.10.20.24.3.97",
} as const;

/** SNOMED sex concept → FHIR `Patient.gender`, inverting the export's `SEX_CONCEPTS`. */
const GENDER_FOR_SNOMED: Record<string, string> = { "248152002": "female", "248153007": "male" };

export class Qrda1ImportError extends Error {}

/**
 * HL7 `YYYYMMDDHHMMSS[±ZZZZ]` → ISO-8601, or undefined when absent/nullFlavored/unparseable.
 *
 * The **offset is applied, not discarded** (Codex, #362). `20251231230000-0500` is
 * `2026-01-01T04:00:00Z`, a different day and a different YEAR — and a measurement period is a
 * half-open interval on exactly that boundary, so dropping the offset silently moves events in and out
 * of populations. Base HL7 asks for the offset (CONF:81-10130) even though the CMS Hospital IG asks for
 * its absence (CMS_0121), so a conformant document may well carry one.
 */
function isoFromHl7(value: string | undefined): string | undefined {
  if (!value || !/^\d{8}/.test(value)) return undefined;
  const [y, mo, d] = [value.slice(0, 4), value.slice(4, 6), value.slice(6, 8)];
  const offset = /([+-])(\d{2})(\d{2})$/.exec(value);
  const digits = offset ? value.slice(0, value.length - 5) : value;
  if (digits.length < 12) {
    // Validate the date-only path too. `00000000` (a MariaDB zero date) used to become
    // `"0000-00-00"` and flow into `Patient.birthDate`, where CMS125's IPP feeds it to `AgeAt(...)`.
    // The export has `hl7TsOrNull` guarding the other direction; this branch had nothing (review, #362).
    const probe = new Date(`${y}-${mo}-${d}T00:00:00Z`);
    if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return undefined;
    return `${y}-${mo}-${d}`;
  }
  const [h, mi, s] = [digits.slice(8, 10), digits.slice(10, 12), digits.slice(12, 14) || "00"];
  const zone = offset ? `${offset[1]}${offset[2]}:${offset[3]}` : "Z";
  const parsed = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A CDA coded element → a FHIR CodeableConcept, or undefined when it is nullFlavored/unmapped. */
function concept(node: CdaNode | undefined): { coding: Array<{ system: string; code: string; display?: string }> } | undefined {
  const code = node?.attrs.code;
  const system = node?.attrs.codeSystem ? SYSTEM_FOR_OID[node.attrs.codeSystem] : undefined;
  if (!code || !system) return undefined;
  const display = node!.attrs.displayName;
  return { coding: [{ system, code, ...(display ? { display } : {}) }] };
}

/** `<effectiveTime>` → `{ point, start, end }` in ISO, whichever the element expresses. */
function times(node: CdaNode | undefined): { point?: string; start?: string; end?: string } {
  if (!node) return {};
  const point = isoFromHl7(node.attrs.value);
  if (point) return { point };
  return { start: isoFromHl7(child(node, "low")?.attrs.value), end: isoFromHl7(child(node, "high")?.attrs.value) };
}

/**
 * The FHIR `id` this entry was exported under.
 *
 * Deliberately ROOT-AGNOSTIC: it takes the first `<id>` carrying an `extension`, whatever the root. That
 * is what let the export change its own root (`urn:workwell:fhir` → `FHIR_RESOURCE_ID_ROOT`, so CDA's
 * `uid` type would accept it) without touching ADR-051's round trip, and it is also what lets us import
 * a third party's document, whose root will never be ours.
 */
function idOf(node: CdaNode, fallback: string): string {
  const own = childrenNamed(node, "id").find((n) => n.attrs.extension);
  return own?.attrs.extension ?? fallback;
}

function encounterFrom(node: CdaNode, i: string): unknown {
  const t = times(child(node, "effectiveTime"));
  const type = concept(child(node, "code"));
  return {
    resourceType: "Encounter",
    id: idOf(node, `qrda1-encounter-${i}`),
    status: "finished",
    ...(type ? { type: [type] } : {}),
    ...(t.start || t.end || t.point
      ? { period: { ...(t.start ?? t.point ? { start: t.start ?? t.point } : {}), ...(t.end ? { end: t.end } : {}) } }
      : {}),
  };
}

function conditionFrom(node: CdaNode, i: string): unknown {
  const t = times(child(node, "effectiveTime"));
  // The patient's condition is the VALUE; `<code>` says only "this entry is a diagnosis".
  const code = concept(child(node, "value"));
  if (!code) return undefined;
  return {
    resourceType: "Condition",
    id: idOf(node, `qrda1-condition-${i}`),
    verificationStatus: { coding: [{ code: "confirmed" }] },
    code,
    ...(t.start ?? t.point ? { onsetDateTime: t.start ?? t.point } : {}),
    ...(t.end ? { abatementDateTime: t.end } : {}),
  };
}

function observationFrom(node: CdaNode, i: string, category: string): unknown {
  const code = concept(child(node, "code"));
  if (!code) return undefined;
  const t = times(child(node, "effectiveTime"));
  // A Laboratory Test carries its result in a nested Result observation; a Diagnostic Study carries an
  // outer `value` which is `nullFlavor="NA"` for a study with no coded result (ADR-050).
  const nested = descendants(node, "observation").find((n) => hasTemplate(n, T.result));
  const valueNode = child(nested ?? node, "value") ?? child(node, "value");
  const quantity = valueNode?.attrs["xsi:type"] === "PQ" && valueNode.attrs.value !== undefined
    ? { value: Number(valueNode.attrs.value), ...(valueNode.attrs.unit ? { unit: valueNode.attrs.unit } : {}) }
    : undefined;
  const coded = valueNode?.attrs["xsi:type"] === "CD" ? concept(valueNode) : undefined;
  // An interval stays an interval. Collapsing `<low>`+`<high>` to a single `effectiveDateTime` drops the
  // end, and a lab or study whose relevant period OVERLAPS a measurement window is exactly the case
  // temporal CQL predicates turn on (Codex, #362).
  const when =
    t.start && t.end
      ? { effectivePeriod: { start: t.start, end: t.end } }
      : (t.point ?? t.start)
        ? { effectiveDateTime: (t.point ?? t.start)! }
        : t.end
          ? { effectivePeriod: { end: t.end } }
          : {};
  return {
    resourceType: "Observation",
    id: idOf(node, `qrda1-observation-${i}`),
    status: "final",
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: category }] }],
    code,
    ...when,
    ...(quantity && Number.isFinite(quantity.value) ? { valueQuantity: quantity } : {}),
    ...(coded ? { valueCodeableConcept: coded } : {}),
  };
}

function procedureFrom(node: CdaNode, i: string): unknown {
  const code = concept(child(node, "code"));
  if (!code) return undefined;
  const t = times(child(node, "effectiveTime"));
  return {
    resourceType: "Procedure",
    id: idOf(node, `qrda1-procedure-${i}`),
    status: "completed",
    code,
    ...(t.point ? { performedDateTime: t.point } : {}),
    ...(t.start || t.end
      ? { performedPeriod: { ...(t.start ? { start: t.start } : {}), ...(t.end ? { end: t.end } : {}) } }
      : {}),
  };
}

/** `<recordTarget>` → a FHIR Patient. */
function patientFrom(root: CdaNode): { resource: unknown; id: string } {
  const patientRole = child(child(root, "recordTarget"), "patientRole");
  const patient = child(patientRole, "patient");
  const id = childrenNamed(patientRole, "id").find((n) => n.attrs.extension)?.attrs.extension ?? "qrda1-subject";
  // Sex is the SNOMED `<translation>`, matching how the exporter writes it and how QI-Core reads it.
  const sexCode = child(child(patient, "administrativeGenderCode"), "translation")?.attrs.code;
  const name = child(patient, "name");
  const given = child(name, "given")?.text;
  const family = child(name, "family")?.text;
  const birthDate = isoFromHl7(child(patient, "birthTime")?.attrs.value);
  return {
    id,
    resource: {
      resourceType: "Patient",
      id,
      ...(GENDER_FOR_SNOMED[sexCode ?? ""] ? { gender: GENDER_FOR_SNOMED[sexCode!] } : {}),
      // **`us-core-sex`, not just `gender`** — and this is the difference between a correct import and a
      // useless one. Official CMS125's initial population reads the US Core sex EXTENSION, never
      // `Patient.gender` (ADR-042 cost a measurement pass establishing exactly that, and
      // `devdb-official-eval.test.ts` pins that stripping it empties the whole roster from the IPP).
      // Writing only `gender` made every imported subject out-of-population for the measure this stack
      // actually routes to official — silently, with a 201 and no untranslated templates (review, #362).
      ...(sexCode
        ? {
            extension: [
              {
                url: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-sex",
                valueCode: sexCode,
              },
            ],
          }
        : {}),
      ...(birthDate ? { birthDate } : {}),
      ...(given || family ? { name: [{ ...(given ? { given: [given] } : {}), ...(family ? { family } : {}) }] } : {}),
    },
  };
}

export interface Qrda1Import {
  /** The subject's `Patient.id`, as the document identifies them. */
  patientId: string;
  /** A collection Bundle the measure engine can evaluate unchanged. */
  bundle: { resourceType: "Bundle"; type: "collection"; entry: Array<{ resource: unknown }> };
  /** Version-specific eMeasure UUID(s) the document references, in document order. */
  measureIdentifiers: string[];
  /** Local measure id when the document carries WorkWell's own urn (an authored-measure export). */
  localMeasureId?: string;
  /** QDM entries seen but not translated — surfaced so a gap is visible rather than silent. */
  untranslatedTemplates: string[];
}

/**
 * Parse a QRDA Category I document into a FHIR bundle the engine can evaluate.
 *
 * Throws `Qrda1ImportError` for input that is not a usable QRDA I. Refusing beats returning an empty
 * bundle: an empty bundle evaluates to out-of-population for every measure, which is indistinguishable
 * from a genuinely ineligible patient — the silent-failure shape ADR-043 exists to prevent.
 */
export function importQrda1Document(xml: string): Qrda1Import {
  const root = parseXml(xml);
  if (!root || root.local !== "ClinicalDocument") {
    throw new Qrda1ImportError("not a CDA document: no <ClinicalDocument> root");
  }
  const sections = descendants(root, "section");
  const patientData = sections.find((s) => hasTemplate(s, T.patientDataSection));
  if (!patientData) {
    throw new Qrda1ImportError(
      "not a QRDA Category I: no Patient Data Section QDM (2.16.840.1.113883.10.20.24.2.1)",
    );
  }

  const { id: patientId, resource: patient } = patientFrom(root);
  const entries: Array<{ resource: unknown }> = [{ resource: patient }];
  const untranslatedTemplates: string[] = [];

  childrenNamed(patientData, "entry").forEach((entry, i) => {
    // EVERY translatable datatype in the entry, not the first. A Result Organizer carrying two
    // Laboratory Tests, Performed is a standard CDA construct, and stopping at the first one dropped the
    // rest AND reported the entry as fully translated — so an HbA1c that is the second component of a
    // chemistry panel vanished with `untranslatedTemplates: []` (review, #362). Diagnosis is nested
    // inside a Diagnosis Concern Act, so the search descends rather than reading immediate children.
    const candidates = new Set<CdaNode>();
    for (const node of entry.children) {
      candidates.add(node);
      for (const kind of ["observation", "encounter", "procedure", "act"] as const) {
        for (const found of descendants(node, kind)) candidates.add(found);
      }
    }
    let translated = 0;
    let index = 0;
    for (const candidate of candidates) {
      const key = `${i}-${index++}`;
      const resource =
        hasTemplate(candidate, T.encounterPerformed) ? encounterFrom(candidate, key)
        : hasTemplate(candidate, T.diagnosis) ? conditionFrom(candidate, key)
        : hasTemplate(candidate, T.labPerformed) ? observationFrom(candidate, key, "laboratory")
        : hasTemplate(candidate, T.studyPerformed) ? observationFrom(candidate, key, "imaging")
        : hasTemplate(candidate, T.procedurePerformed) ? procedureFrom(candidate, key)
        : undefined;
      if (resource !== undefined) {
        entries.push({ resource });
        translated++;
      }
    }
    if (translated === 0) {
      // Named, not counted: an operator needs to know WHICH datatype was dropped to know whether the
      // recalculation can be trusted. A bare count would read as "a few things we don't support".
      const roots = descendants(entry, "templateId").map((t) => t.attrs.root).filter((r): r is string => r !== undefined);
      untranslatedTemplates.push(roots[roots.length - 1] ?? "(no templateId)");
    }
  });

  // A Patient-only bundle is the failure this whole module exists to avoid, and the section being
  // PRESENT but empty reaches it just as surely as the section being absent (Codex, #362). Our own
  // no-bundle export is exactly that document — it declares itself non-conformant (CONF:67-14567), so
  // importing it and persisting a plausible out-of-population outcome would launder a document that
  // says it cannot be calculated from.
  if (entries.length <= 1) {
    throw new Qrda1ImportError(
      untranslatedTemplates.length === 0
        ? "QRDA Category I has no Patient Data entries (CONF:67-14567) — nothing to calculate from"
        : `QRDA Category I has no entry this importer can translate; ${untranslatedTemplates.length} ` +
          `untranslated: ${[...new Set(untranslatedTemplates)].slice(0, 5).join(", ")}`,
    );
  }

  const measureSection = sections.find((s) => hasTemplate(s, T.measureSection));
  const references = descendants(measureSection, "externalDocument");
  const measureIdentifiers: string[] = [];
  let localMeasureId: string | undefined;
  for (const ref of references) {
    for (const id of childrenNamed(ref, "id")) {
      if (id.attrs.root === "2.16.840.1.113883.4.738" && id.attrs.extension) measureIdentifiers.push(id.attrs.extension);
      else if (id.attrs.root === "urn:workwell:measure" && id.attrs.extension) localMeasureId ??= id.attrs.extension;
    }
    // `<setId>` carries the VERSION-INDEPENDENT eMeasure id. A document naming its measure only that way
    // would otherwise match nothing, and the route's measure check would refuse a correct request
    // (review, #362).
    for (const setId of childrenNamed(ref, "setId")) {
      if (setId.attrs.root) measureIdentifiers.push(setId.attrs.root);
    }
  }

  return {
    patientId,
    bundle: { resourceType: "Bundle", type: "collection", entry: entries },
    measureIdentifiers,
    ...(localMeasureId ? { localMeasureId } : {}),
    untranslatedTemplates,
  };
}
