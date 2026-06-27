/**
 * Demo risk-group seed (#183 E11.3). Idempotent by segment name: existing names are left untouched,
 * so re-running on boot is safe and operator edits are never clobbered. Seeds three ENABLED cohorts
 * whose rule-sets together cover EVERY Active runnable measure (no measure is orphaned) while giving the
 * roster grid a meaningful applicable/N-A mix:
 *   - All Employees      — the universal occupational-health baseline (wellness + preventive eCQM + Td/Tdap)
 *   - OSHA Safety-Sensitive — field roles add the OSHA surveillance program
 *   - Clinical Staff     — clinic/nursing roles add infection control + the healthcare-worker immunity series
 * `no-orphaned-measure-in-demo-seed` (segment-seed.test.ts) guards the coverage invariant.
 */
import type { CreateSegmentInput, SegmentStore, SegmentRule } from "../stores/segment-store.ts";
import { getStores, type StoresEnv } from "../stores/factory.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";

/** Every distinct site across ALL tenants — so the universal baseline auto-covers a new tenant's
 *  sites without hand-editing this list (E13 PR-1: the IHN campuses join twh's sites here). */
const ALL_SITES: string[] = [...new Set(EMPLOYEES.map((e) => e.site))].sort((a, b) => a.localeCompare(b));

const BASELINE_NAME = "All Employees";
/** The universal baseline cohort rule — matches every employee by site, across all tenants. */
const BASELINE_RULE: SegmentRule = { match: "ANY", conditions: [{ attr: "site", op: "in", value: ALL_SITES }] };

export const DEMO_SEGMENTS: CreateSegmentInput[] = [
  {
    // Everyone: chronic-disease + preventive screening (incl. the two CMS eCQMs) and the routine
    // adult Td/Tdap booster. CQL still decides per-subject eligibility WITHIN each measure.
    name: BASELINE_NAME,
    description: "Universal occupational-health baseline — wellness screening, preventive eCQMs, and the adult Td/Tdap booster, applicable to everyone.",
    rule: BASELINE_RULE,
    measureIds: [
      "hypertension", "diabetes_hba1c", "obesity_bmi", "cholesterol_ldl", "cms125", "cms122", "adult_immunization",
    ],
  },
  {
    name: "OSHA Safety-Sensitive",
    description: "Field roles in OSHA surveillance programs — adds audiometry, HAZWOPER, and TB screening.",
    rule: { match: "ANY", conditions: [
      { attr: "role", op: "contains", value: "Welder" },
      { attr: "role", op: "contains", value: "Maintenance" },
      { attr: "role", op: "contains", value: "Hazwoper" },
      { attr: "role", op: "contains", value: "Industrial Hygienist" },
    ] },
    measureIds: ["audiogram", "hazwoper", "tb_surveillance"],
  },
  {
    name: "Clinical Staff",
    description: "Clinic-based and nursing staff — adds influenza, TB screening, and the MMR/Varicella/Hep B immunity series.",
    rule: { match: "ANY", conditions: [
      { attr: "site", op: "equals", value: "Clinic" },
      { attr: "role", op: "contains", value: "Nurse" },
    ] },
    measureIds: ["flu_vaccine", "tb_surveillance", "mmr", "varicella", "hepatitis_b_vaccination_series"],
  },
];

/**
 * Idempotently seed the demo segments — skips any whose name already exists (a boot over an
 * already-seeded DB adds no duplicates and never clobbers operator edits). Bootstrap data only.
 *
 * NOTE (E13 PR-1): the baseline rule above now derives its site list from the directory, so a
 * **fresh** DB (the SQLite floor, a new instance) covers every tenant automatically. An
 * **already-seeded** stack (e.g. the live Neon demo seeded pre-E13) keeps its old `All Employees`
 * row because seeding is name-idempotent — and we deliberately do NOT auto-mutate it here: a
 * boot-time write would be unaudited (every state change must write `audit_event`) and could clobber
 * an operator-customized rule. The one-time repair is owner-gated (like all data migrations): widen
 * `All Employees` to the new tenant's sites via the audited `PUT /api/segments/:id` route (the
 * Configure Groups editor), which records a `SEGMENT_UPDATED` audit event. See docs/DEPLOY.md.
 */
export async function seedSegments(store: SegmentStore): Promise<void> {
  const existing = new Set((await store.listSegments()).map((s) => s.name));
  for (const seg of DEMO_SEGMENTS) {
    if (existing.has(seg.name)) continue;
    await store.createSegment(seg);
  }
}

// Seed runs exactly once per env object (the host builds env once + reuses it across requests).
const seeded = new WeakMap<object, Promise<void>>();

/**
 * Ensure the demo segments are seeded before any segment consumer reads them. Every route that reads
 * segments (the /api/segments CRUD, the compliance roster, the run pipeline's case gate) calls this
 * first, so a cold-DB first hit to ANY of them seeds the table — rather than only the /api/measures
 * initializer, which the segment/roster/run routes never trigger (else the zero-enabled-segments
 * fallback would silently bypass the overlay + case gating until a measures request happened).
 * Idempotent + cached per env, so concurrent cold-start requests share one seed.
 */
export function ensureSegmentSeed(env: StoresEnv): Promise<void> {
  const key = env as object;
  let pending = seeded.get(key);
  if (!pending) {
    pending = (async () => {
      const stores = await getStores(env);
      await seedSegments(stores.segments);
    })();
    seeded.set(key, pending);
    // If the seed fails (e.g. a transient DB error), evict so the next request retries.
    void pending.catch(() => {
      if (seeded.get(key) === pending) seeded.delete(key);
    });
  }
  return pending;
}
