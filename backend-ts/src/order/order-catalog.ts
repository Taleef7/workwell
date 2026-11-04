/**
 * Action evaluators (#77 E7; #620, #640): runnable measure → the orders that could close an open gap.
 *
 * **Codes are representative (demo, not billing-certified)**, and none is offered on a CDS card until an admin
 * approves it as a terminology mapping (owner decision 2026-11-04, `measure/value-set-governance.ts`). Where a
 * `terminology_mappings` seed entry exists (value-set-seed.ts) we REUSE its standard code + system so a future
 * EH standing-order query deduplicates against the same code: audiogram→CPT 92557, tb_surveillance→CPT 86580,
 * flu_vaccine→CVX 141, and hazwoper→`hazwoper-exam`. A LOCAL `urn:workwell:orders` code stands where no
 * standard one is appropriate; it is listed for staff but never becomes a card suggestion (`suggestible`),
 * because a receiving EHR cannot apply it.
 *
 * **Protocol or choice (#640 item 3).** A protocol measure has exactly ONE option, proposed as the order. A
 * choice measure lists its options and the clinician picks one: nothing anywhere treats its first option as
 * a default (choice rows carry no `order`, `order-proposal.ts`).
 *
 * **When an order is offered (`offerOn`).** An order closes a gap only when nothing qualifying was found. A
 * result that is not controlled, a positive screen without a follow-up, or a missed engagement is not fixed
 * by ordering the test again, and a card saying so would state a clinical action the CQL outcome does not
 * support (AI_GUARDRAILS §1.1). The rule reads what the measure's own CQL found (`order-applicability.ts`).
 *
 * System URIs match the vendored measure terminology exactly (`measures/official/<id>/terminology.json`), so
 * an approved mapping's `standardSystem|standardCode` matches the option it approves.
 */
import type { OrderCode } from "./proposed-order.ts";

export const CPT = "http://www.ama-assn.org/go/cpt";
export const CVX = "http://hl7.org/fhir/sid/cvx";
export const LOINC = "http://loinc.org";
export const HCPCS = "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets";
const HAZWOPER_VS = "urn:workwell:vs:hazwoper-exams";
export const LOCAL_ORDERS = "urn:workwell:orders"; // no standard code is appropriate (e.g. BMI)

export type OrderMode = "protocol" | "choice";

/**
 * Which outcomes an order is offered for (`order-applicability.ts`):
 * - `at-risk`: every open gap (the measure's only failure is that nothing was done);
 * - `none-found`: only when CQL found nothing qualifying (`NONE_FOUND`), never a found-but-failing result;
 * - `none-found-first-rate`: as `none-found`, and only when the missed rate is the first (CMS137 Initiation).
 */
export type OfferRule = "at-risk" | "none-found" | "none-found-first-rate";

export interface OrderOption extends OrderCode {
  /** How often it is repeated: catalog text shown in the app only, never on a card. */
  interval?: string;
  /** Who the option is for ("18 and over"): a label, never a rule WorkWell applies. */
  audience?: string;
  /** False for a LOCAL code: listed for staff, never a card suggestion. Default true. */
  suggestible?: boolean;
  /** A catalog note shown in the app only (e.g. how Medicare bills it). */
  note?: string;
}

export interface MeasureOrders {
  mode: OrderMode;
  options: readonly OrderOption[];
  offerOn: OfferRule;
  /** One line the case page adds under the options (CMS137's window). */
  caveat?: string;
}

const protocol = (option: OrderOption): MeasureOrders => ({ mode: "protocol", options: [option], offerOn: "at-risk" });

export const ORDER_CATALOG: Record<string, MeasureOrders> = {
  audiogram: protocol({ code: "92557", system: CPT, display: "Comprehensive audiometry evaluation" }),
  tb_surveillance: protocol({ code: "86580", system: CPT, display: "TB intradermal skin test" }),
  flu_vaccine: protocol({ code: "141", system: CVX, display: "Influenza seasonal injectable" }),
  adult_immunization: protocol({ code: "115", system: CVX, display: "Tdap vaccine" }),
  mmr: protocol({ code: "03", system: CVX, display: "MMR vaccine" }),
  varicella: protocol({ code: "21", system: CVX, display: "Varicella vaccine" }),
  hepatitis_b_vaccination_series: protocol({ code: "189", system: CVX, display: "Hepatitis B vaccine (Heplisav-B)" }),
  diabetes_hba1c: protocol({ code: "83036", system: CPT, display: "Hemoglobin A1c" }),
  cholesterol_ldl: protocol({ code: "80061", system: CPT, display: "Lipid panel" }),
  hypertension: protocol({ code: "99473", system: CPT, display: "Self-measured blood pressure" }),
  obesity_bmi: protocol({ code: "bmi-screening", system: LOCAL_ORDERS, display: "BMI screening & counseling" }),
  hazwoper: protocol({ code: "hazwoper-exam", system: HAZWOPER_VS, display: "HAZWOPER medical surveillance exam" }),

  // ── The pilot's six (ADR-078) ──────────────────────────────────────────────────────────────────────────
  // Inverse measure: OVERDUE also means a result above 9%, which another HbA1c does not fix. Only CQL's own
  // "no record" (NONE_FOUND) gets the order.
  cms122: { mode: "protocol", options: [{ code: "83036", system: CPT, display: "Hemoglobin A1c" }], offerOn: "none-found" },
  cms125: protocol({ code: "77067", system: CPT, display: "Screening mammography, bilateral", interval: "every 2 years" }),
  // Which screening fits is the patient's age; WorkWell decides no age (`wiring/official-facts.ts`), so the
  // two are labelled and the clinician chooses.
  cms2: {
    mode: "choice",
    offerOn: "none-found",
    options: [
      { code: "73832-8", system: LOINC, display: "Adult depression screening assessment", audience: "18 and over" },
      { code: "73831-0", system: LOINC, display: "Adolescent depression screening assessment", audience: "12 to 17" },
    ],
  },
  cms130: {
    mode: "choice",
    offerOn: "at-risk",
    options: [
      { code: "45378", system: CPT, display: "Colonoscopy", interval: "every 10 years", note: "Medicare bills a screening colonoscopy as HCPCS G0121" },
      { code: "82274", system: CPT, display: "Fecal immunochemical test (FIT)", interval: "every year" },
      { code: "81528", system: CPT, display: "Stool DNA with FIT (FIT-DNA)", interval: "every 3 years" },
      { code: "45330", system: CPT, display: "Flexible sigmoidoscopy", interval: "every 5 years" },
      { code: "74263", system: CPT, display: "CT colonography", interval: "every 5 years" },
    ],
  },
  // A reading found and not controlled is managed, not re-ordered: only "no reading counts" gets these.
  cms165: {
    mode: "choice",
    offerOn: "none-found",
    options: [
      { code: "99473", system: CPT, display: "Self-measured blood pressure: device and training" },
      { code: "bp-recheck-visit", system: LOCAL_ORDERS, display: "Blood pressure recheck visit", suggestible: false },
    ],
  },
  cms137: {
    mode: "choice",
    offerOn: "none-found-first-rate",
    caveat: "Treatment counts for this measure only if it starts within 14 days of the episode. CQL decides.",
    options: [
      { code: "H0001", system: HCPCS, display: "Alcohol and/or drug assessment" },
      { code: "H0004", system: HCPCS, display: "Behavioral health counseling" },
    ],
  },
};

export function ordersForMeasure(measureId: string): MeasureOrders | null {
  return ORDER_CATALOG[measureId] ?? null;
}

/** The ONE order of a protocol measure; null for a choice measure (which has no default) or an unknown one. */
export function orderForMeasure(measureId: string): OrderCode | null {
  const m = ORDER_CATALOG[measureId];
  if (!m || m.mode !== "protocol") return null;
  const { code, system, display } = m.options[0]!;
  return { code, system, display };
}

export const codeKey = (o: Pick<OrderCode, "system" | "code">): string => `${o.system}|${o.code}`;

export const isSuggestible = (o: OrderOption): boolean => o.suggestible !== false && o.system !== LOCAL_ORDERS;
