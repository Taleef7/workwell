/**
 * The ids of every vendored official artifact — the directory names under `measures/official/`.
 *
 * `config/` must not import `standards/official-cases.ts` (its header declares it diagnostic-only,
 * ADR-026, and it must stay off the boot path). The gated set is instead read off the filesystem,
 * which is sound because `official-gate.test.ts` pins OFFICIAL_GATED_MEASURES === this listing. One
 * readdirSync at module load, guarded so a missing directory cannot stop the worker booting; no JSON
 * is parsed here.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OFFICIAL_ROOT = fileURLToPath(new URL("../../measures/official/", import.meta.url));

/**
 * Read once, at module load — and NOT allowed to throw. This module is imported by
 * `config/deployment-profile.ts` and `run/compliance-period.ts`, both on the worker boot path, so an
 * unreadable or absent `measures/official/` would take the whole worker down at import time with an
 * ENOENT and no diagnosis. Degrading to an empty set is the honest failure: `classifyRunnable` then
 * reports every official-only id as `invalid` with a reason naming the directory, which surfaces as a
 * measure that will not run rather than as a process that will not start.
 */
function readVendoredIds(): ReadonlySet<string> {
  try {
    return new Set(
      readdirSync(OFFICIAL_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
    );
  } catch (error) {
    console.error(
      `[workwell] cannot read vendored official artifacts at ${OFFICIAL_ROOT} — ` +
        `${error instanceof Error ? error.message : String(error)}. No official-only measure can run ` +
        "until this is fixed; authored measures are unaffected.",
    );
    return new Set();
  }
}

export const VENDORED_OFFICIAL_MEASURE_IDS: ReadonlySet<string> = readVendoredIds();

export const isVendoredOfficialMeasure = (id: string): boolean => VENDORED_OFFICIAL_MEASURE_IDS.has(id);
