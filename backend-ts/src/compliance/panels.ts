/**
 * Roster column sets (E10.2). Each panel scopes the roster grid to a coherent group of measures,
 * standing in for E11's risk-group/segment column scoping. Ids are the runnable measure ids.
 */
import { isRunnableMeasure } from "../config/deployment-profile.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";

export type PanelId = "immunizations" | "osha" | "wellness";

export const PANELS: Record<PanelId, string[]> = {
  immunizations: ["mmr", "varicella", "hepatitis_b_vaccination_series", "adult_immunization", "flu_vaccine"],
  osha: ["audiogram", "hazwoper", "tb_surveillance"],
  wellness: ["hypertension", "diabetes_hba1c", "obesity_bmi", "cholesterol_ldl", "cms122", "cms125"],
};

export const DEFAULT_PANEL: PanelId = "immunizations";

export const isPanelId = (s: string): s is PanelId => Object.prototype.hasOwnProperty.call(PANELS, s);

// Safe as a module-level snapshot because the measure catalog is a compile-time constant.
export const ACTIVE_CATALOG_MEASURE_IDS = new Set(
  MEASURE_CATALOG.filter((m) => m.status === "Active").map((m) => m.id),
);

const isCatalogActiveRunnable = (measureId: string): boolean =>
  ACTIVE_CATALOG_MEASURE_IDS.has(measureId) && isRunnableMeasure(measureId);

export const RUNNABLE_PANELS: Record<PanelId, string[]> = Object.fromEntries(
  (Object.keys(PANELS) as PanelId[]).map((id) => [id, PANELS[id].filter(isCatalogActiveRunnable)]),
) as Record<PanelId, string[]>;

export const AVAILABLE_PANELS: PanelId[] = (Object.keys(PANELS) as PanelId[]).filter(
  (id) => RUNNABLE_PANELS[id].length > 0,
);

/**
 * The panel a request falls back to. When a profile leaves NO panel with a runnable, catalog-Active
 * measure this degenerates to DEFAULT_PANEL and the roster serves zero columns — reachable in MM-1,
 * where cms2/cms130/cms165 belong to no panel. `availablePanels: []` is the signal a client reads;
 * this warning is the one an operator reads, because an empty roster is otherwise indistinguishable
 * from "no data yet" (the ADR-043 hazard: a silent empty result is the dangerous one).
 */
export const PROFILE_DEFAULT_PANEL: PanelId = AVAILABLE_PANELS[0] ?? DEFAULT_PANEL;
if (AVAILABLE_PANELS.length === 0) {
  console.warn(
    "[workwell] No roster panel has a runnable, catalog-Active measure for this deployment profile; " +
      "the compliance roster will render no columns. Add the profile's measures to a panel in panels.ts.",
  );
}
