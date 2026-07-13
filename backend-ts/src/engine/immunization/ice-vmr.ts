/**
 * vMR codec for the ICE (Immunization Calculation Engine) DSS REST contract — pure build/parse,
 * no I/O, NO new deps (string templates + tolerant regex parse, the same hand-rolled-XML pattern
 * as the QRDA stub, `fhir/qrda.ts`). Contract live-verified against `hlnconsulting/ice:latest`
 * on 2026-07-13 (docs/superpowers/specs/2026-07-13-ice-sidecar-spike.md):
 *
 * - Request: DSS JSON envelope; the patient data is a base64-encoded vMR `CDSInput` XML in
 *   `evaluationRequest.dataRequirementItemData[0].data.base64EncodedPayload`. That field is an
 *   ARRAY of base64 strings — a bare string is rejected `400 Bad Request` by the live engine
 *   (verified 2026-07-13; the canonical ICE test payload sends `["<base64>"]`).
 * - Response: `finalKMEvaluationResponse[0].kmEvaluationResultData[0].data.base64EncodedPayload[0]`
 *   (an ARRAY on this side too) → base64 → vMR `CDSOutput` XML, one
 *   `<substanceAdministrationProposal>` per vaccine group.
 * - Dates in the request are plain YYYY-MM-DD; timestamps in the response are
 *   `YYYYMMDDhhmmss.SSS±ZZZZ`.
 */

export interface IceDose {
  cvx: string; // CVX vaccine code (codeSystem 2.16.840.1.113883.12.292)
  date: string; // administration date, YYYY-MM-DD
}

export interface CdsInputParams {
  patientId: string;
  dob: string; // YYYY-MM-DD
  gender: "M" | "F";
  doses: IceDose[];
}

export type IceRecommendation = "RECOMMENDED" | "FUTURE_RECOMMENDED" | "CONDITIONAL" | "NOT_RECOMMENDED";

export interface IceProposal {
  /**
   * ICE vaccine GROUP code (codeSystem 2.16.840.1.113883.3.795.12.100.1), e.g. 800 = Influenza,
   * 200 = DTP, 100 = Hep B. Read from the nested `<observationFocus>`, NOT from `<substanceCode>`:
   * ICE sometimes proposes a concrete product instead of a group, in which case `substanceCode`
   * carries a CVX (e.g. 115 Tdap, 187 Shingrix) while `observationFocus` still carries the group
   * (200 DTP, 620 Zoster). Keying on the substance would silently lose those groups
   * (verified live 2026-07-13 — a patient with no DTP history gets substance=115/focus=200).
   */
  groupCode: string;
  groupName: string;
  /** The concrete substance ICE proposes — a group code or a specific CVX, with its code system. */
  proposedSubstanceCode: string;
  proposedSubstanceSystem: string;
  recommendation: IceRecommendation;
  interpretations: string[]; // ICE recommendation-reason codes (DUE_NOW, COMPLETE, HIGH_RISK, ...)
  proposedDate: string | null; // proposedAdministrationTimeInterval@low → YYYY-MM-DD (the due date)
  earliestDate: string | null; // validAdministrationTimeInterval@low → YYYY-MM-DD
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Build the vMR `CDSInput` XML — the canonical ICE request shape, parameterized. */
export function buildCdsInputXml(params: CdsInputParams): string {
  const doses = params.doses
    .map(
      (d, i) => `<substanceAdministrationEvent>
<templateId root="2.16.840.1.113883.3.795.11.9.1.1"/>
<id root="2.16.840.1.113883.3.795.12.100.10" extension="${i + 1}"/>
<substanceAdministrationGeneralPurpose code="384810002" codeSystem="2.16.840.1.113883.6.5"/>
<substance><id root="2.16.840.1.113883.3.795.12.100.10.${i + 1}"/><substanceCode code="${escapeXml(d.cvx)}" codeSystem="2.16.840.1.113883.12.292"/></substance>
<administrationTimeInterval high="${escapeXml(d.date)}" low="${escapeXml(d.date)}"/>
</substanceAdministrationEvent>`,
    )
    .join("\n");
  const clinicalStatements = params.doses.length
    ? `<clinicalStatements><substanceAdministrationEvents>\n${doses}\n</substanceAdministrationEvents></clinicalStatements>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns3:cdsInput xmlns:ns2="org.opencds.vmr.v1_0.schema.cdsinput.specification" xmlns:ns3="org.opencds.vmr.v1_0.schema.cdsinput" xmlns:ns4="org.opencds.vmr.v1_0.schema.cdsoutput" xmlns:ns5="org.opencds.vmr.v1_0.schema.vmr">
<templateId root="2.16.840.1.113883.3.795.11.1.1"/>
<cdsContext><cdsSystemUserPreferredLanguage code="en" codeSystem="2.16.840.1.113883.6.99" displayName="English"/></cdsContext>
<vmrInput>
<templateId root="2.16.840.1.113883.3.795.11.1.1"/>
<patient>
<templateId root="2.16.840.1.113883.3.795.11.2.1.1"/>
<id root="2.16.840.1.113883.3.795.12.100.11" extension="${escapeXml(params.patientId)}"/>
<demographics><birthTime value="${escapeXml(params.dob)}"/><gender code="${params.gender}" codeSystem="2.16.840.1.113883.5.1"/></demographics>
${clinicalStatements}
</patient>
</vmrInput>
</ns3:cdsInput>`;
}

export interface DssRequest {
  interactionId: { scopingEntityId: string; interactionId: string; submissionTime: number };
  evaluationRequest: {
    clientLanguage: string;
    clientTimeZoneOffset: string;
    kmEvaluationRequest: Array<{ kmId: { scopingEntityId: string; businessId: string; version: string } }>;
    dataRequirementItemData: Array<{
      driId: { containingEntityId: { scopingEntityId: string; businessId: string; version: string }; itemId: string };
      data: {
        informationModelSSId: { scopingEntityId: string; businessId: string; version: string };
        /** ARRAY, not a string — the live engine 400s on a bare string (see the header note). */
        base64EncodedPayload: string[];
      };
    }>;
  };
}

/**
 * Wrap a CDSInput XML in the DSS evaluate envelope. `submissionTimeMs` is injected by the caller
 * so this stays a pure function (and stable under test).
 */
export function buildDssRequest(opts: { cdsInputXml: string; submissionTimeMs: number }): DssRequest {
  return {
    interactionId: {
      scopingEntityId: "org.nyc.cir",
      interactionId: String(opts.submissionTimeMs),
      submissionTime: opts.submissionTimeMs,
    },
    evaluationRequest: {
      clientLanguage: "en",
      clientTimeZoneOffset: "+0000",
      kmEvaluationRequest: [{ kmId: { scopingEntityId: "org.nyc.cir", businessId: "ICE", version: "1.0.0" } }],
      dataRequirementItemData: [
        {
          driId: {
            containingEntityId: { scopingEntityId: "org.nyc.cir", businessId: "ICEData", version: "1.0.0" },
            itemId: "cdsPayload",
          },
          data: {
            informationModelSSId: { scopingEntityId: "org.opencds.vmr", businessId: "VMR", version: "1.0" },
            base64EncodedPayload: [btoa(opts.cdsInputXml)],
          },
        },
      ],
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Extract + decode the vMR `CDSOutput` XML from a DSS response envelope. The payload lives at
 * `finalKMEvaluationResponse[0].kmEvaluationResultData[0].data.base64EncodedPayload` and is an
 * ARRAY of base64 strings in the live response (verified); a plain string is tolerated.
 */
export function parseDssResponse(envelope: unknown): string {
  const walk = (o: unknown): unknown => {
    if (isObject(o)) {
      if ("base64EncodedPayload" in o) return o.base64EncodedPayload;
      for (const v of Object.values(o)) {
        const r = walk(v);
        if (r !== undefined) return r;
      }
    } else if (Array.isArray(o)) {
      for (const v of o) {
        const r = walk(v);
        if (r !== undefined) return r;
      }
    }
    return undefined;
  };
  const payload = walk(envelope);
  const b64 = Array.isArray(payload) ? payload[0] : payload;
  if (typeof b64 !== "string" || !b64) {
    throw new Error("ICE DSS response carried no base64EncodedPayload");
  }
  return atob(b64);
}

/** `YYYYMMDDhhmmss.SSS±ZZZZ` → `YYYY-MM-DD`, or null when absent/malformed. */
export function parseIceTimestamp(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const m = /^(\d{4})(\d{2})(\d{2})\d{6}/.exec(ts);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo}-${d}`;
}

const RECOMMENDATIONS: ReadonlySet<string> = new Set([
  "RECOMMENDED",
  "FUTURE_RECOMMENDED",
  "CONDITIONAL",
  "NOT_RECOMMENDED",
]);

/**
 * Parse every `<substanceAdministrationProposal>` out of a vMR `CDSOutput` XML. Tolerant regex
 * scan (the vMR subset ICE emits is stable and flat enough); a proposal with an unknown
 * recommendation code is skipped rather than guessed at.
 */
export function parseCdsOutputProposals(cdsOutputXml: string): IceProposal[] {
  const proposals: IceProposal[] = [];
  const blocks = cdsOutputXml.match(/<substanceAdministrationProposal>[\s\S]*?<\/substanceAdministrationProposal>/g) ?? [];
  for (const block of blocks) {
    const substance = /<substance><substanceCode code="([^"]+)" codeSystem="([^"]+)"/.exec(block);
    // The vaccine GROUP is on the nested observationFocus — see the IceProposal.groupCode note.
    const focus = /<observationFocus code="([^"]+)"[^>]*?(?:displayName="([^"]*)")?\/>/.exec(block);
    const value = /<observationValue><concept code="([^"]+)"/.exec(block);
    const groupCode = focus?.[1];
    const groupName = focus?.[2] ?? "";
    const proposedSubstanceCode = substance?.[1];
    const proposedSubstanceSystem = substance?.[2];
    const recommendation = value?.[1];
    if (
      !groupCode ||
      !proposedSubstanceCode ||
      !proposedSubstanceSystem ||
      !recommendation ||
      !RECOMMENDATIONS.has(recommendation)
    ) {
      continue;
    }
    const proposed = /<proposedAdministrationTimeInterval low="([^"]*)"/.exec(block);
    const valid = /<validAdministrationTimeInterval low="([^"]*)"/.exec(block);
    const interpretations = [...block.matchAll(/<interpretation code="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((c): c is string => c !== undefined && c !== "SUPPLEMENTAL_TEXT");
    proposals.push({
      groupCode,
      groupName,
      proposedSubstanceCode,
      proposedSubstanceSystem,
      recommendation: recommendation as IceRecommendation,
      interpretations,
      proposedDate: parseIceTimestamp(proposed?.[1]),
      earliestDate: parseIceTimestamp(valid?.[1]),
    });
  }
  return proposals;
}
