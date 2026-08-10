# Terminology & Standards Currency Audit — 2026-07-08

**Scope:** a three-way verification of every medical/clinical code and standard WorkWell uses —
**(1) our implementation** vs **(2) what MIE's WebChart dev DB (`ghcr.io/mieweb/dev-wcdb`) actually
emits** vs **(3) the current 2026 authoritative standards** (CMS eCQI, CDC CVX, LOINC, VSAC, AMA CPT,
eCFR/OSHA). Motivated by the realistic-population generator work (E9/Option A) — the generator must
stamp active, current, enforceable codes.

**Method:** six parallel research agents — two inventorying the code (our implementation + the #246
WebChart dev-DB crosswalk), four web-verifying against authoritative sources (LOINC+CVX+SNOMED;
CPT+CMS+OSHA; the full 49-entry CMS catalog; and the authoritative *active* vaccine code sets).

## Verdict

**Correct and current on everything load-bearing. The only genuine defects were vaccine-CVX currency
(inactive/legacy codes on the WebChart read path), now fixed.**

| Standard family | Result |
|---|---|
| OSHA CFR (1910.95 / .120 / .134 / .1025) | ✅ Correct & current; TB correctly attributed to CDC, not OSHA |
| CMS eCQM version year | ✅ **v14 = 2026** confirmed (2024=v12 → 2025=v13 → 2026=v14); do **not** advance to v15 |
| Full CMS catalog (49 entries) | ✅ Every version, MIPS Quality ID, and title correct for the 2026 EC set; no retirements affect us |
| CMS122v14 / CMS125v14 | ✅ Titles, MIPS 001/112, and CMS122 HbA1c-OR-GMI numerator all correct |
| Runnable LOINC (`4548-4`, `2089-1`, `8480-6`, `39156-5`, `97506-0`) | ✅ All active & correct; `2089-1`/`8480-6` = MIE's confirmed dev-DB codes (#246) |
| Runnable CPT (`92557`, `86580`, `86480`, `83036`, `83721`, `77067`) | ✅ Active & unchanged in the 2026 CPT set |
| SNOMED `44054006` (T2DM) | ✅ Correct (test data; prod resolves diabetes via the VSAC set) |
| **Vaccine CVX** | ⚠️ **Several inactive/legacy codes → FIXED (see below)** |

## Defects found & fixed (this PR)

The WebChart crosswalk (`backend-ts/src/engine/ingress/webchart/terminology.ts`) is the **enforceable
real-data path** (real WebChart code → the measure's synthetic event coding). Currency matters most here.
All fixes are **purely additive read-path rows with zero synthetic-outcome impact** (the synthetic
evaluation path matches synthetic `urn:workwell:*` codes, not CVX numbers; verified — 1020 tests still pass
with no outcome change).

1. **Influenza — the biggest gap.** Matching only CVX `141`/`140` missed the high-dose (`135`/`197`),
   recombinant (`155`/`185`), adjuvanted (`168`/`205`), quadrivalent (`150`/`158`), and cell-based
   (`171`/`186`) codes that make up the majority of real flu records. Expanded to the full active seasonal
   set: `141,140,111,135,149,150,153,155,158,168,171,185,186,197,205,231,320,333,337`. The deprecated
   `88` ("unspecified") was removed from the governance display set. The compliance-grade grouping is the
   VSAC **"Influenza Vaccine"** value set **OID `2.16.840.1.113883.3.526.3.1254`** (NOT
   `2.16.840.1.113762.1.4.1010.6`, which is the all-vaccines US Core CVX set).
2. **Td/Tdap — a real currency bug.** CVX `139` (Td, unspecified) is **INACTIVE** and was the *only* Td
   code in the crosswalk. Added the active adult Td codes `09`/`113`/`196` (Tdap `115` was already correct);
   `139` retained as a read-only row for legacy records (`138` was never a crosswalk row and stays absent).
3. **MMRV → varicella.** Added CVX `94` (MMRV) to the varicella matcher so an MMRV dose counts toward
   varicella immunity (it already counted toward MMR).
4. **`G0202` (mammography HCPCS) — deleted in 2018** (replaced by CPT `77067`). Kept as a read-only row for
   the legacy dev-DB record; commented as inactive.

Inactive codes that are **present as read-only crosswalk rows** (so legacy records still match, never
emitted): Td `139`, Hep B `45`, HCPCS `G0202`. Other inactive codes (`88`, Td `138`, Hep B `220`
PreHevbrio, flu `15/16/144/151`) are intentionally **absent** — neither matched nor emitted. All CVX
codes listed as active were confirmed CDC-Active on 2026-07-08 (the 2024/25 US reversion to trivalent flu
*reactivated* the trivalent codes `111/135/140/141/153/155/168/320`, so all 19 flu codes are Active).

## Verified clean — no change needed

- **All 49 CMS eCQM catalog entries** (versions, MIPS Quality IDs, titles) for the 2026 EC period.
- **All OSHA CFR citations** and the CDC-for-TB attribution.
- **All runnable-measure LOINC and CPT codes** (active/current for 2026).

## Known follow-ups (not blocking; tracked here)

- **Durable:** resolve flu (and ideally all vaccine) membership from the VSAC "Influenza Vaccine" value set
  (`2.16.840.1.113883.3.526.3.1254`) via the existing `ValueSetResolver`/VSAC on-ramp (ADR-023), rather than
  the hardcoded active list — flu codes churn every season. The hardcoded active set is the correct interim.
- **Cosmetic (non-blocking):** the OSHA-minimum audiogram is technically CPT `92552` (pure-tone air only);
  `92557` (comprehensive) is broader but valid. `CMS1154v1`'s catalog title could be expanded to the full
  "Screening for Abnormal Glucose Metabolism in Patients at Risk of Developing Diabetes." The retired
  `CMS249` version string is moot. Generic E/M codes (`99213`/`99401`) as governance event codes read as
  placeholders. None affect evaluation.
- **For the generator:** vaccines have **no grounding in Doug's dev seed** (no CVX/immunization table — that
  is ICE's domain), so the realistic generator stamps vaccine CVX itself and must use the active codes above.
  `cms122` needs a diabetes diagnosis stamped (SNOMED `44054006` / VSAC Diabetes set) — the dev seed lacked one.

## Authoritative sources

- CMS "2026 Electronic Clinical Quality Measures for Eligible Clinicians" table (eCQI Resource Center /
  `cms.gov`); eCQI 2026 EC eCQM pages (`ecqi.healthit.gov/ecqm/ec/2026/cmsNNNNvNN`); CY2026 Medicare PFS
  Final Rule (confirms MIPS #514/#515 additions).
- CDC CVX code set (`www2a.cdc.gov/vaccines/iis/iisstandards/vaccines.asp?rpt=cvx`) + CVX→vaccine-group map;
  CDC Fall respiratory codes (season flu set).
- LOINC (`loinc.org`); VSAC (`vsac.nlm.nih.gov`) for value-set OIDs; AMA CPT 2026; eCFR / OSHA for CFR titles.
