# Vendored official CMS122v14 eCQM artifact (LITERAL execution diff — #258 / ADR-026)

This directory vendors the **official, computable FHIR measure bundle** for CMS122v14 (Diabetes:
Glycemic Status Assessment Greater Than 9%). It is executed **as-is** — from its **pre-compiled ELM** —
by MITRE's `fqm-execution` to power the LITERAL tier of `GET /api/measures/cms122/fidelity/diff`
(`backend-ts/src/standards/literal-diff.ts`). **No CQL→ELM translation happens** (which is what ADR-024
found intractable under the pinned JVM-free translator); the committed ELM is what runs.

## Provenance

| Field | Value |
|---|---|
| Source repo | [`cqframework/ecqm-content-cms-2025`](https://github.com/cqframework/ecqm-content-cms-2025) (the CMS/MADiE FHIR content for the 2026 reporting year) |
| Source path | `bundles/mat/CMS122FHIR-R2-MeasureExport/CMS122FHIR-v0.5.000-FHIR.json` |
| Pinned commit | `30a627013f1c41e00d6386e256d5c0337c375d1a` (2025-09-06) |
| Measure | `CMS122FHIRDiabetesAssessGreaterThan9Percent` v0.5.000 — canonical `https://madie.cms.gov/Measure/CMS122FHIRDiabetesAssessGreaterThan9Percent` |
| Data model | `using QICore version '6.0.0'` — the **literal multi-library** artifact (includes FHIRHelpers, QICoreCommon, SupplementalDataElements, Status, AdvancedIllnessandFrailty, Hospice, PalliativeCare) |
| Retrieved | 2026-07-09 |

Downloadable via the eCQI Resource Center / MADiE export; the `cqframework/ecqm-content-cms-2025`
repository is the canonical published home of the MADiE-exported CMS FHIR content.

## File

- `CMS122FHIR-v0.5.000-FHIR.json` — a self-contained FHIR `transaction` Bundle: 1 `Measure` + 9 `Library`
  resources. **Every library carries base64 `application/elm+json`** (the gate for #258 — verified
  `MISSING ELM: NONE`) + `text/cql`.
  - `sha256`: `7554910d1992840db7f37977faa98d4b54c106c6c55e0c861667e3274eb35f75`
  - size: 8,901,862 bytes

### Modification from the upstream file (documented)

The upstream file is ~13.4 MB because each Library carries **both** `application/elm+xml` **and**
`application/elm+json` compiled forms. `fqm-execution` reads only `application/elm+json`, so the
redundant `application/elm+xml` content blobs (8 of them) were **stripped** to keep the vendored file
lean (~8.9 MB). Nothing execution-relevant was removed: the authoritative compiled `application/elm+json`
and the human-readable `text/cql` for all 9 libraries are retained. This is the **only** change from the
upstream bytes.

## Usage notes

- `fqm-execution` is a **diagnostic-only** dependency (ADR-026): imported solely by `literal-diff.ts`,
  reached solely from the fidelity-diff route — never the run pipeline, ingress, or `worker.ts`
  (guarded by `standards/fqm-isolation.test.ts`).
- Value sets are supplied to `fqm-execution` via a `valueSetCache` built from the imported VSAC
  `value_sets` rows (ADR-023) — **no runtime VSAC/UMLS key needed**.
- Descriptive only (ADR-008): the literal diff writes nothing and never sets an `Outcome Status`.
