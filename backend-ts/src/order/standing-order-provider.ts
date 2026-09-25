/**
 * StandingOrderProvider port (#77 E7) — the dedupe seam: existing active orders a member already has,
 * so a proposal isn't a duplicate (the charter's "duplicate orders are bad"). With no order source
 * configured there are NO standing orders; an inert EH stub is selected ONLY when both
 * WORKWELL_EH_FHIR_* env vars are set (inert-unless-configured, mirroring SendGrid/ICE). The real EH
 * adapter (a FHIR `ServiceRequest?subject=&status=active` query) is the documented drop-in behind this
 * port.
 *
 * Until #616 the unconfigured default invented a standing order for about one subject in five, from a
 * hash of the id, and the orders page listed each as "standing order on file": on the pilot, 46 at-risk
 * patients had their HbA1c or mammogram proposal withheld (and left out of the FHIR bundle) for a
 * reason that was not real. Nothing invents clinical data, so an unconfigured seam returns nothing.
 */
import type { OrderCode } from "./proposed-order.ts";

export interface StandingOrder {
  subjectId: string;
  order: OrderCode;
}

export interface StandingOrderProvider {
  /**
   * Whether this provider actually looks at the orders already placed. False means an empty answer is
   * "not checked", not "none on file", and the orders page says so rather than implying its proposals
   * are known to be new.
   */
  readonly checksExistingOrders: boolean;
  activeOrdersFor(subjectId: string): StandingOrder[];
}

export interface StandingOrderEnv {
  WORKWELL_EH_FHIR_BASE_URL?: string;
  WORKWELL_EH_FHIR_API_KEY?: string;
}

/** The unconfigured default: no order source, so no standing orders and nothing checked. */
export const noStandingOrderProvider: StandingOrderProvider = {
  checksExistingOrders: false,
  activeOrdersFor: () => [],
};

export function ehStandingOrderProvider(_config: { apiKey: string; baseUrl: string }): StandingOrderProvider {
  // STUB: a real impl would GET `${baseUrl}/ServiceRequest?subject=<id>&status=active` with the key,
  // and only then set `checksExistingOrders: true`.
  return { checksExistingOrders: false, activeOrdersFor: () => [] };
}

/**
 * Pure predicate for whether the EH FHIR stub is selected — both BASE_URL and API_KEY required. The
 * single source of truth for `resolveStandingOrderProvider` and the boot-time seam inventory (#260).
 */
export function isEhFhirConfigured(env: StandingOrderEnv): boolean {
  const apiKey = (env.WORKWELL_EH_FHIR_API_KEY ?? "").trim();
  const baseUrl = (env.WORKWELL_EH_FHIR_BASE_URL ?? "").trim();
  return Boolean(apiKey && baseUrl);
}

export function resolveStandingOrderProvider(env: StandingOrderEnv): StandingOrderProvider {
  if (isEhFhirConfigured(env)) {
    const apiKey = (env.WORKWELL_EH_FHIR_API_KEY ?? "").trim();
    const baseUrl = (env.WORKWELL_EH_FHIR_BASE_URL ?? "").trim();
    return ehStandingOrderProvider({ apiKey, baseUrl });
  }
  return noStandingOrderProvider;
}
