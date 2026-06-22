/**
 * Roster column sets (E10.2). Each panel scopes the roster grid to a coherent group of measures,
 * standing in for E11's risk-group/segment column scoping. Ids are the runnable measure ids.
 */
export type PanelId = "immunizations" | "osha" | "wellness";

export const PANELS: Record<PanelId, string[]> = {
  immunizations: ["mmr", "varicella", "hepatitis_b_vaccination_series", "adult_immunization", "flu_vaccine"],
  osha: ["audiogram", "hazwoper", "tb_surveillance"],
  wellness: ["hypertension", "diabetes_hba1c", "obesity_bmi", "cholesterol_ldl", "cms122", "cms125"],
};

export const DEFAULT_PANEL: PanelId = "immunizations";

export const isPanelId = (s: string): s is PanelId => Object.prototype.hasOwnProperty.call(PANELS, s);
