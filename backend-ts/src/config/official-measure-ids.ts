/**
 * The ids of every vendored official artifact — the directory names under `measures/official/`.
 *
 * `config/` must not import `standards/official-cases.ts` (its header declares it diagnostic-only,
 * ADR-026, and it must stay off the boot path). The gated set is instead read off the filesystem,
 * which is sound because `official-gate.test.ts` pins OFFICIAL_GATED_MEASURES === this listing. One
 * readdirSync at module load; no JSON is parsed here.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OFFICIAL_ROOT = fileURLToPath(new URL("../../measures/official/", import.meta.url));

export const VENDORED_OFFICIAL_MEASURE_IDS: ReadonlySet<string> = new Set(
  readdirSync(OFFICIAL_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(),
);

export const isVendoredOfficialMeasure = (id: string): boolean => VENDORED_OFFICIAL_MEASURE_IDS.has(id);
