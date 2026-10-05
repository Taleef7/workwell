/**
 * The `terminology-equivalence` oracle: a WorkWell translation's terminology sidecar holds exactly the
 * codes the Cypress deck's value-set export lists for the release, for every value set its ELM declares —
 * and it changed exactly the value sets the release changed relative to CMS's artifact.
 *
 * Whose list that is, precisely: the Cypress/CVU team's export of the VSAC release (for CMS137v15, the
 * 2027 deck's `value-sets/value-set-codes.csv`, eCQM Update 2026-05-14). It is an independent copy of the
 * same release the translation was expanded from, not a code list published by the measure's steward.
 *
 * Why this is a separate oracle from the deck: CMS137 v15 changes only value sets, and the Cypress deck
 * scores 36/36 under both the 2026 and the 2027 terminology, so a passing deck says nothing about which
 * codes the translation carries. This is where the value-set proof lives.
 *
 * The three conditions, over the declared OIDs, with D = { oid : cypress(oid) ≠ official(oid) }:
 *   (a) D is not empty — otherwise the CSV agrees with CMS's 2026 terminology everywhere and cannot be the
 *       release that changed it (or the release string matched the wrong rows);
 *   (b) the OIDs the translation changed relative to CMS's artifact are exactly D;
 *   (c) the translation equals Cypress on every declared OID.
 * (c) implies (b); (b) is reported separately because "changed the wrong value sets" and "changed the
 * right ones to the wrong codes" are different findings.
 *
 * Counts only, never codes: the report says how many codes each set gained or lost, not which.
 */
import { SYSTEM_FOR_OID } from "../fhir/qrda1-import.ts";

/** A code as the sidecar and the CSV both resolve to it: `system|code`. */
type CodeKey = string;

export interface ExpandedCodeLike {
  system: string;
  code: string;
}

/**
 * Code-system OID → the FHIR system URI VSAC's FHIR expansions use, for reading the CSV.
 *
 * `SYSTEM_FOR_OID` (the QRDA importer's map) plus the vocabularies a value set may carry that a QRDA
 * entry never needs mapping. Each URI below is the one the vendored sidecars or the VSAC FHIR expansions
 * actually carry (checked against `measures/official/*\/terminology.json` and a 2027 VSAC FHIR dump), not
 * one a specification suggests. A wrong entry here fails CLOSED: its codes match nothing in a sidecar, so
 * the value set reads as different and the oracle fails naming it.
 */
export const CSV_SYSTEM_FOR_OID: Readonly<Record<string, string>> = {
  ...SYSTEM_FOR_OID,
  // Source of Payment Typology (Payer Type).
  "2.16.840.1.113883.3.221.5": "https://nahdo.org/sopt",
  // CDC Race and Ethnicity — VSAC's FHIR expansions keep the OID form.
  "2.16.840.1.113883.6.238": "urn:oid:2.16.840.1.113883.6.238",
  // NHSN Healthcare Service Location (HSLOC).
  "2.16.840.1.113883.6.259": "https://www.cdc.gov/nhsn/cdaportal/terminology/codesystem/hsloc.html",
  // Present on Admission indicator.
  "2.16.840.1.113883.6.301.11": "https://www.cms.gov/Medicare/Medicare-Fee-for-Service-Payment/HospitalAcqCond/Coding",
  // HL7 v3 RoleCode.
  "2.16.840.1.113883.5.111": "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
};

/** `Release:eCQM Update 2026-05-14` and `eCQM Update 2026-05-14` are one release in the CSV. */
export const normaliseRelease = (release: string): string => release.trim().replace(/^Release:\s*/i, "");

export interface CompareSidecarInput {
  /** The translation's sidecar, by OID (`loadOfficialTerminology(...).codesByOid`). */
  translation: ReadonlyMap<string, readonly ExpandedCodeLike[]>;
  /** CMS's artifact's sidecar, by OID. */
  official: ReadonlyMap<string, readonly ExpandedCodeLike[]>;
  /** The deck's `value-sets/value-set-codes.csv`, pipe-delimited, with a header row. */
  csvText: string;
  /** The OIDs the translation's ELM declares. */
  requiredOids: readonly string[];
  /** The release whose rows count, e.g. `eCQM Update 2026-05-14` (a `Release:` prefix is ignored). */
  release: string;
  systemForOid: Readonly<Record<string, string>>;
}

export interface OidEquivalence {
  oid: string;
  cypress: number;
  official: number;
  translation: number;
  /** In Cypress's set and not CMS's artifact's — what the release added. */
  addedByRelease: number;
  removedByRelease: number;
  /** In Cypress's set and not the translation's. */
  missingFromTranslation: number;
  extraInTranslation: number;
  changedByRelease: boolean;
  changedByTranslation: boolean;
  equalToCypress: boolean;
}

export interface TerminologyEquivalence {
  release: string;
  result: "pass" | "fail";
  /** Declared OIDs whose translation set equals Cypress's. */
  agree: number;
  /** Declared OIDs. */
  total: number;
  changedByRelease: string[];
  changedByTranslation: string[];
  oids: OidEquivalence[];
  problems: string[];
}

/**
 * Cypress's codes per declared OID at one release. A row whose code system has no mapping THROWS rather
 * than being skipped: a skipped row is a code silently dropped from Cypress's side, and the oracle would
 * then pass a translation missing exactly that code.
 */
export function cypressCodesByOid(
  csvText: string,
  requiredOids: readonly string[],
  release: string,
  systemForOid: Readonly<Record<string, string>>,
): { codes: Map<string, Set<CodeKey>>; otherReleases: Map<string, Set<string>> } {
  const lines = csvText.replace(/^﻿/, "").split(/\r?\n/);
  const header = (lines[0] ?? "").split("|").map(unquote);
  const column = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`value-set CSV has no ${name} column (header: ${header.join("|")})`);
    return i;
  };
  const iOid = column("OID");
  const iRelease = column("ExpansionVersion");
  const iCode = column("Code");
  const iSystem = column("CodeSystemOID");
  const wanted = normaliseRelease(release);
  const required = new Set(requiredOids);
  const codes = new Map<string, Set<CodeKey>>();
  const otherReleases = new Map<string, Set<string>>();
  lines.forEach((line, index) => {
    if (index === 0 || line === "") return;
    const fields = line.split("|").map(unquote);
    // A pipe inside a field shifts every column after it; reading on would attribute a code to the wrong
    // system. Refuse the file instead.
    if (fields.length !== header.length) {
      throw new Error(`value-set CSV line ${index + 1} has ${fields.length} fields, the header ${header.length}`);
    }
    const oid = fields[iOid]!;
    if (!required.has(oid)) return;
    const rowRelease = normaliseRelease(fields[iRelease]!);
    if (rowRelease !== wanted) {
      const seen = otherReleases.get(oid) ?? new Set<string>();
      seen.add(rowRelease);
      otherReleases.set(oid, seen);
      return;
    }
    const systemOid = fields[iSystem]!;
    const system = systemForOid[systemOid];
    if (!system) throw new Error(`value set ${oid}: code system ${systemOid} has no FHIR system mapping — add it rather than skip its codes`);
    const set = codes.get(oid) ?? new Set<CodeKey>();
    set.add(`${system}|${fields[iCode]}`);
    codes.set(oid, set);
  });
  return { codes, otherReleases };
}

function unquote(field: string): string {
  return field.length >= 2 && field.startsWith('"') && field.endsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field;
}

const keysOf = (codes: readonly ExpandedCodeLike[] | undefined): Set<CodeKey> => new Set((codes ?? []).map((c) => `${c.system}|${c.code}`));
const minus = (a: ReadonlySet<CodeKey>, b: ReadonlySet<CodeKey>): number => [...a].filter((k) => !b.has(k)).length;
const same = (a: ReadonlySet<CodeKey>, b: ReadonlySet<CodeKey>): boolean => a.size === b.size && minus(a, b) === 0;

export function compareSidecarToCypressCsv(input: CompareSidecarInput): TerminologyEquivalence {
  const required = [...new Set(input.requiredOids)];
  const release = normaliseRelease(input.release);
  const { codes, otherReleases } = cypressCodesByOid(input.csvText, required, release, input.systemForOid);
  const problems: string[] = [];
  const oids: OidEquivalence[] = [];
  for (const oid of required) {
    const cypress = codes.get(oid);
    if (!cypress) {
      const elsewhere = [...(otherReleases.get(oid) ?? [])];
      problems.push(
        elsewhere.length
          ? `${oid}: the CSV lists it only at ${elsewhere.join(", ")}, not at ${release}`
          : `${oid}: declared by the translation but absent from the CSV`,
      );
    }
    const c = cypress ?? new Set<CodeKey>();
    const o = keysOf(input.official.get(oid));
    const t = keysOf(input.translation.get(oid));
    oids.push({
      oid,
      cypress: c.size,
      official: o.size,
      translation: t.size,
      addedByRelease: minus(c, o),
      removedByRelease: minus(o, c),
      missingFromTranslation: minus(c, t),
      extraInTranslation: minus(t, c),
      changedByRelease: !same(c, o),
      changedByTranslation: !same(t, o),
      // An OID with no Cypress rows at the release never counts as equal, whatever the sidecar holds.
      equalToCypress: !!cypress && same(t, c),
    });
  }
  const changedByRelease = oids.filter((o) => o.changedByRelease).map((o) => o.oid);
  const changedByTranslation = oids.filter((o) => o.changedByTranslation).map((o) => o.oid);
  if (changedByRelease.length === 0) {
    problems.push(`no declared value set differs between CMS's artifact and the CSV at ${release}: that is not the release the translation was built for`);
  }
  const sameChanges =
    changedByRelease.length === changedByTranslation.length && changedByRelease.every((oid) => changedByTranslation.includes(oid));
  if (!sameChanges) {
    problems.push(
      `the translation changed ${changedByTranslation.length} value set(s) relative to CMS's artifact; the release changed ${changedByRelease.length}, and they are not the same set`,
    );
  }
  const unequal = oids.filter((o) => !o.equalToCypress);
  if (unequal.length) problems.push(`${unequal.length} declared value set(s) differ from the CSV: ${unequal.map((o) => o.oid).join(", ")}`);
  const agree = oids.length - unequal.length;
  return {
    release,
    result: problems.length === 0 && oids.length > 0 ? "pass" : "fail",
    agree,
    total: oids.length,
    changedByRelease,
    changedByTranslation,
    oids,
    problems,
  };
}
