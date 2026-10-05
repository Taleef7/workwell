#!/usr/bin/env -S node --import tsx
/**
 * Per-patient agreement between WorkWell's FHIR execution and a Cypress bundle's own expected results.
 *
 * A Cypress measure bundle carries, for every test patient and measure, Cypress's precalculated
 * populations (`calculations/individual-results/*.json`) next to the patient as a QRDA Category I
 * (`patients/*.xml`). This script imports each patient through `qrda1-import.ts`, runs the measure's
 * FHIR artifact over them with the bundle's own measurement period, and compares every population of
 * every rate, and every stratum, patient by patient. No Cypress server is needed, unlike
 * `c2-calculation-check.ts`, which grades Cypress's split-and-duplicated product-test archives.
 *
 *   cd backend-ts && corepack pnpm@10 exec node --import tsx ../scripts/cvu/bundle-agreement.ts \
 *     --bundle-dir C:/cvu-data/cypress/bundle-2026 --measure cms125 [--valuesets-dir C:/cvu-data/vsac-2027]
 *
 * `--bundle-dir` is an EXTRACTED bundle zip. Bundles and value sets are licensed (UMLS): keep them outside
 * the repository and never commit what this prints beyond aggregate counts.
 *
 * `--artifact official|derived` (default official) picks CMS's vendored artifact or the WorkWell
 * translation under `measures/derived/`. A translation runs on its own terminology sidecar only, so
 * `--valuesets-dir` is refused with it.
 *
 * `--valuesets-dir` swaps the artifact's vendored terminology for FHIR ValueSet expansions on disk (one
 * JSON per value set), so a value-set vintage difference can be told apart from a logic difference.
 *
 * `--strata compare|count` (default compare): each `PopulationSet_N_Stratification_M` row is compared
 * (the patient is in stratum M of rate N and in no other, with rate N's populations), or only counted.
 *
 * Each measure runs the way production runs it: `trustMetaProfile` comes from the measure's semantics
 * (`official-measure-semantics.ts`), and the mode is printed. `--trust-meta-profile on|off` overrides it
 * for diagnosis only, and the output says so; a number from an overridden run is not what the QRDA I
 * route would produce.
 *
 * The comparison lives in `backend-ts/src/standards/cypress-agreement.ts`, shared with `derived:check`.
 * This script supplies the calculator, which is why it may import the executor package directly: it is
 * outside `src/`, so the package-import allowlist does not reach it.
 *
 * Descriptive only: it writes nothing and authors no compliance status. Exit 2 on engine errors, 1 on a
 * usage or loading problem, else 0.
 */
import { agreementCli } from "../../backend-ts/src/standards/cypress-agreement.ts";
import { calculateOfficialWithSignal } from "../../backend-ts/packages/official-executor/src/index.ts";

export async function main(argv: readonly string[]): Promise<number> {
  return agreementCli(argv, { calculate: (input) => calculateOfficialWithSignal(input) });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("bundle-agreement.ts")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
