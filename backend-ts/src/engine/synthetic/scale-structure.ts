/**
 * Population-scale tenant structure + subject_id codec (#185 E13 PR-2). The "MetroHealth Network"
 * (mhn) tenant's ~120k subjects do NOT live in the in-memory directory — they exist only as outcome
 * rows whose subject_id encodes their place in the hierarchy. This module holds the SMALL structure
 * (24 locations × 10 providers = 240 provider nodes) used to NAME rollup nodes, plus the codec that
 * the scale seed writes and the SQL aggregation reads. No employees here.
 */
import type { Tenant } from "./employee-catalog.ts";

export const SCALE_TENANT: Tenant = { id: "mhn", name: "MetroHealth Network" };

export interface ScaleLocation { id: string; name: string; }
export interface ScaleProvider { id: string; name: string; locationId: string; }

const LOCATION_COUNT = 24;
const PROVIDERS_PER_LOCATION = 10;
const pad2 = (n: number): string => String(n).padStart(2, "0");

export const SCALE_LOCATIONS: readonly ScaleLocation[] = Array.from({ length: LOCATION_COUNT }, (_, i) => ({
  id: `L${pad2(i)}`,
  name: `MetroHealth Region ${i + 1}`,
}));

const PROVIDERS_BY_LOC = new Map<string, ScaleProvider[]>();
for (let li = 0; li < LOCATION_COUNT; li++) {
  const locId = `L${pad2(li)}`;
  PROVIDERS_BY_LOC.set(
    locId,
    Array.from({ length: PROVIDERS_PER_LOCATION }, (_, pi) => ({
      id: `P${pad2(pi)}`,
      // Name providers like clinicians, not clinics (UX-9): the rollup renders these on a PROVIDER-badged
      // row, so "Clinic 1-1 · PROVIDER" read as two contradictory nouns.
      name: `Dr. Provider ${li + 1}-${pi + 1}`,
      locationId: locId,
    })),
  );
}

/** Providers serving a scale location (sorted by id); [] for an unknown location. */
export function scaleProvidersFor(locationId: string): ScaleProvider[] {
  return PROVIDERS_BY_LOC.get(locationId) ?? [];
}

/** Enterprise name for the scale tenant (1:1 tenant↔enterprise, matching PR-1). */
export const enterpriseNameForScale = (): string => SCALE_TENANT.name;

/** Encode a scale subject id: `mhn|L07|P03|0000123`. */
export function encodeScaleSubject(locIdx: number, provIdx: number, n: number): string {
  return `${SCALE_TENANT.id}|L${pad2(locIdx)}|P${pad2(provIdx)}|${String(n).padStart(7, "0")}`;
}

export interface DecodedScaleSubject { tenantId: string; locationId: string; providerId: string; n: number; }

/** Decode a scale subject id; null when it isn't one. */
export function decodeScaleSubject(subjectId: string): DecodedScaleSubject | null {
  const parts = subjectId.split("|");
  if (parts.length !== 4 || parts[0] !== SCALE_TENANT.id) return null;
  const n = Number(parts[3]);
  if (!Number.isFinite(n)) return null;
  return { tenantId: parts[0]!, locationId: parts[1]!, providerId: parts[2]!, n };
}

export const isScaleSubject = (subjectId: string): boolean => subjectId.startsWith(`${SCALE_TENANT.id}|`);
