/**
 * StandingOrderProvider port (#77 E7) — the dedupe seam: existing active orders a member already has,
 * so a proposal isn't a duplicate (the charter's "duplicate orders are bad"). Simulated default;
 * an inert EH stub is selected ONLY when both WORKWELL_EH_FHIR_* env vars are set
 * (inert-unless-configured, mirroring SendGrid/ICE). The real EH adapter (a FHIR
 * `ServiceRequest?subject=&status=active` query) is the documented drop-in behind this port.
 */
import type { OrderCode } from "./proposed-order.ts";
import { ORDER_CATALOG } from "./order-catalog.ts";

export interface StandingOrder {
  subjectId: string;
  order: OrderCode;
}

export interface StandingOrderProvider {
  activeOrdersFor(subjectId: string): StandingOrder[];
}

export interface StandingOrderEnv {
  WORKWELL_EH_FHIR_BASE_URL?: string;
  WORKWELL_EH_FHIR_API_KEY?: string;
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

// Deterministic synthetic standing orders: ~1 in 5 subjects already has a standing order for a
// stable measure picked from the catalog — enough to demonstrate dedupe suppression without
// suppressing most proposals.
const CATALOG_ENTRIES = Object.entries(ORDER_CATALOG);
export const simulatedStandingOrderProvider: StandingOrderProvider = {
  activeOrdersFor(subjectId) {
    const h = hash(subjectId);
    if (h % 5 !== 0) return [];
    const entry = CATALOG_ENTRIES[h % CATALOG_ENTRIES.length];
    if (!entry) return [];
    const [, order] = entry;
    return [{ subjectId, order }];
  },
};

export function ehStandingOrderProvider(_config: { apiKey: string; baseUrl: string }): StandingOrderProvider {
  // STUB: a real impl would GET `${baseUrl}/ServiceRequest?subject=<id>&status=active` with the key.
  return { activeOrdersFor: () => [] };
}

export function resolveStandingOrderProvider(env: StandingOrderEnv): StandingOrderProvider {
  const apiKey = (env.WORKWELL_EH_FHIR_API_KEY ?? "").trim();
  const baseUrl = (env.WORKWELL_EH_FHIR_BASE_URL ?? "").trim();
  if (apiKey && baseUrl) return ehStandingOrderProvider({ apiKey, baseUrl });
  return simulatedStandingOrderProvider;
}
