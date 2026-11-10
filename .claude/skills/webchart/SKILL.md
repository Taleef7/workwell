---
name: webchart
description: Work with the WebChart/MIE integration — FHIR ingest, the wcdb-fhir-shim, the dev MariaDB, tenant config, or mapping WebChart data to QI-Core. Use when touching any WORKWELL_WEBCHART_* path, the crosswalk, or live-tenant data.
---

# WebChart integration

Read **`docs/WEBCHART_API_ASSUMPTIONS_2026-07.md`** (the verified contract) and
**`docs/WEBCHART_FHIR_MAPPING.md`** (the crosswalk). Traps first.

## Traps — check these first

1. **Variant A is BUILT; Variant B is documented but NOT built.** The assumptions doc describes both a
   true FHIR R4 API (implemented, tagged where verified) and a proprietary REST fallback over
   `wc_miehr_*` shapes that was never built. Do not code against Variant B as if it exists.
2. **Known server quirks:** 400s on `_count`, 403s on bare `/Patient`, bulk export only per partition
   (`Group/{id}/$export`, and Group search 403s, so the id cannot be found over FHIR), BP panels come
   back with `status=unknown`, and no `DeviceRequest` in the CapabilityStatement (checked 2026-10-08).
3. **The live path has real data gaps that break official measures.** Measured 2026-07-29 against the
   committed dev-DB corpus, across 56 patients: **0 Conditions, 0 Encounters, no Patient `extension`,
   no `Observation.category`**. So official CMS122 reads out-of-population over live data, and the two
   recorded CMS125 blockers (no `us-core-sex` extension, now derived from gender; no LOINC mammography
   result, and a billed CPT 77067 / HCPCS G0202 deliberately never becomes one, #894) are only part of it. This gap is M-D-sized — do not assume ADR-038's static-corpus fixes cover it.
4. **Official-artifact coverage of the live WebChart path is narrow.** `devdb-official-eval.test.ts` (the dev-DB
   sample, fixture transport) and `live-official-parity.test.ts` (us-core-sex derivation) are the only official
   checks on it. Don't infer more coverage from the `official-cases` suite.
5. Dev DB: Doug's seeded `ghcr.io/mieweb/dev-wcdb:latest` MariaDB on port 33306, `wc_miehr_wctroot`.

The live tenant: `docs/DEPLOY.md` "Staging environment" is current; the original runbook is in git history
(`git show before-docs-trim:docs/WEBCHART_TEATEA_RUNBOOK_2026-07-16.md`).
