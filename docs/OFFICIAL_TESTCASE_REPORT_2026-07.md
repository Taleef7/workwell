# Official MADiE eCQM Test-Case Report — July 2026

**Generated:** 2026-07-15
**Content:** `cqframework/dqm-content-qicore-2025` master (2025 AU / 2026 performance period)
**Content revision:** `ca4b49516de4cbed9f92bfb7c35d97b1bf1022ab`
**Engine:** `fqm-execution` 1.8.5 over pre-compiled ELM; offline, no server, DB, VSAC key, or request path

Raw comparisons below are population membership only. `E/A` means expected/actual. CMS122 is an inverse measure; numerator membership is never translated into a WorkWell compliance label.

## Reproduce

Run from the repository root (the fetch script is Windows/PowerShell-aware and enables Git long paths):

```powershell
cd backend-ts
.\scripts\fetch-official-cases.ps1
pnpm test:official-cases [--measure cms122|cms125] [--content-dir <path>]
# If pnpm is not directly on PATH: corepack pnpm test:official-cases
```

The fetch script sparse-checks out only the two measure bundles and two test-case trees into ignored `.official-content/`; it refuses to overwrite an unrelated non-Git directory.

## Summary

| Measure | Cases | Raw expected agreement | Known-bad expecteds matching reference | Reference-adjusted pass | Unexpected mismatches | Errors |
|---|---:|---:|---:|---:|---:|---:|
| CMS122 | 55 | 55 (100.0%) | 0 | 55 (100.0%) | 0 | 0 |
| CMS125 | 66 | 66 (100.0%) | 0 | 66 (100.0%) | 0 | 0 |

† CMS122 reference agreement means the actual vector differs from the committed MADiE expected only at numerator `0→1` for one of the six UUIDs already reported by the source repo. It is an adjusted pass, not an engine defect.

## Execution and terminology controls

`fqm-execution` 1.8.5 reads ValueSet resources from the measure Bundle before adding any optional external cache. ValueSets are consumed directly from each official measure Bundle; no VSAC network call or key is used.

**Measurement-period caveat:** date-only period ends are normalized to end-of-day because fqm-execution 1.8.5 parses them as start-of-day (upstream issue to be filed); the un-normalized run scores 64/66.

- **CMS122:** trustMetaProfile=false (first pass; no retry); 26/26 Bundle ValueSets carry expansions; 1 expansion(s) report more total codes than are present; fqm warnings=0.
  - Cap candidate: `http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.464.1003.110.12.1082` — 1000/1997 codes present. A mismatch involving a missing code from this set must be classified as a value-set-cap candidate, not automatically as an engine bug.
- **CMS125:** trustMetaProfile=false (first pass; no retry); 32/32 Bundle ValueSets carry expansions; 1 expansion(s) report more total codes than are present; fqm warnings=0.
  - Cap candidate: `http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.464.1003.110.12.1082` — 1000/1997 codes present. A mismatch involving a missing code from this set must be classified as a value-set-cap candidate, not automatically as an engine bug.

## Investigated findings

- **CMS122 source calibration:** 6/6 known-bad-expected UUIDs matched the committed numerator=0 value; 0/6 reproduced the source comparison's numerator=1 result. This is reported separately from adjusted pass/fail.

## CMS122 — CMS122FHIRDiabetesAssessGT9Pct

Measurement period: 2026-01-01 → 2026-12-31. Raw expected agreement 55/55; reference-adjusted pass 55/55.

| Case | UUID | IPP E/A | DENOM E/A | DENEX E/A | NUMER E/A | Result |
|---|---|---:|---:|---:|---:|---|
| IPPass PatientAge75 | `090ad2fc-274b-4fef-bc5a-2077dbdc28f5` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXPass LivingInNursingHome | `12ccd41a-83aa-405a-83b3-c756564c4de5` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| IPPass MedicalNutritionTherapy | `1e954801-6437-4abc-8fb8-d36b5b5b97d8` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| IPFail PatientAge76 | `1fa14a28-3be6-4299-ac4f-68772805748a` | 0/0 | 0/0 | 0/0 | 0/0 | PASS |
| NUMPass LabA1cNullResultInMP | `21695544-0997-4b9a-989c-a535da22d033` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| IPPass EstablishedOfficeVisit | `24fa66c5-52ba-4386-a5e7-7b78002be77a` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXPass FrailtySymptomOverlapsMP | `3b62b0a8-44f2-4365-bcb9-7cadef5bab2e` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXFail AdvIllnessDxWithin2YrsNoFrailty | `511548fc-b5c3-4f90-83c6-e04f8e1c98cc` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| IPPass TelephoneVisit | `514a74ba-baea-4102-b2e7-050f84c79ef8` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| IPPass MedicalNutritionTherapy5 | `5d692a54-a1d5-4a9c-80ba-fb6b20112484` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| NUMFail HbA1cLessThan9 | `5ed37c9e-85a3-4819-8051-3d960159cae0` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| SDEPass SDECoverage | `61793aba-9080-4521-9083-a23f242b8d0a` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXPass PalliativeCareDiagnosisDuringMP | `63ae0b9f-2636-4bf3-85ef-4ff20bdb09de` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass HospiceDiagnosisOverlapsMP | `64ba4a87-8cf6-4cfb-b0e7-506dd08c8bbe` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| NUMPass GMIGreaterThan9 | `6630d394-c81d-42f5-a218-40b73a2a4949` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXPass HospiceServiceRequestDuringMP | `6b6a5f96-c2a8-43f1-a353-7b5700ecb031` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| IPFail NoQualifyingEnc | `6d3523ab-25c4-4e98-9ed4-342d7e7f5091` | 0/0 | 0/0 | 0/0 | 0/0 | PASS |
| DENEXPass HospiceCondOverlapsMP | `6d9426d1-5554-4d6b-9ed0-e3736dd17482` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass PalliativeCareSurveyOverlapsAfterMP | `6f0553ac-e12a-4af5-ad27-05339f4b4ec0` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| IPFail NoDiabetesDx | `7312a078-5757-4fab-82a4-1f70c8f107bc` | 0/0 | 0/0 | 0/0 | 0/0 | PASS |
| IPPass OfficeVisit | `7706188a-f37c-483d-96c2-4d7eab833605` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXPass HospiceProcDurMP | `7d01a597-c0da-4bff-9bdd-f3516021db34` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass FrailtyDeviceRequestNoPerformedModExt | `7e69124d-ff34-4daf-b626-08d1283f71ba` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass OneInpatientVisitDuringMP | `85b60f52-7b08-46f3-946b-cb317b28acf5` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass PalliativeCareEncounterDuringMP | `86a25ad7-3801-4297-a9a4-b36b5308c9e2` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass HospiceEncDuringMP | `88b67805-bfef-411c-a191-12382d2c3104` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| NUMPass HbA1cGreaterThan9 | `8956ebb5-d3c0-4112-a34a-200961713efd` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXFail PalliativeCareDiagnosisStartsAfterMP | `8b1155b0-ff08-4f28-90e7-ac0e622f840c` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXPass HospiceEncOverlapsMP | `8b8ded15-0118-4d0c-ac0f-6797528cefb9` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXFail PalliativeCareSurveyStatusNotFinal | `8fa86a00-fa67-4dd6-b2d8-6fe23edde9c7` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXPass PalliativeCareDiagnosisDuringMP2 | `91986c00-e45b-4e7c-afa7-734d6fe43d16` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass HospiceObsIsYes | `96cfe7f0-b4e1-4e2e-a48d-ef64fb64343d` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| IPPass PatientAge18 | `981dbc54-03ac-4f2e-a008-dbedfcbd2a7a` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXFail LastHousingStatusNotNursingHome | `98735c81-5c91-4709-9392-558ac6d40b6c` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXPass FrailtyEncOverlapsMP | `9cba6cfa-9671-4850-803d-e286c7d59ee7` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| NUMPass GMILabTest | `9da62d36-585d-455e-8cb5-8e5da1f3e476` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| SDEPass SDECoverage2 | `a6b08556-8019-43ad-8ab0-0c213f3789ca` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXFail HospiceEncB4MP | `a7332447-3a23-42b1-bfc2-d93cc5b775af` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| NUMPass LabA1cNoResultInMP | `ab29ab81-b4fc-4817-bd9c-98d8d4b4a3a3` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| IPPass MedicalNutritionTherapy4 | `abe87c54-c0b1-4f86-94ca-360a228e9aa3` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXPass TwoOutpatientVisitsDifferentDays | `ac4d7076-d1cb-44c6-a94f-c2c86266d53b` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| IPFail PatientAge17 | `ad9a8d0c-7d40-49ee-9088-6676f5916c1f` | 0/0 | 0/0 | 0/0 | 0/0 | PASS |
| DENEXPass HospiceDiscDurMP | `b6a4b9f8-21c1-44f2-a834-72f0906b4f88` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| IPPass MedicalNutritionTherapy2 | `c66e4e0a-5479-461c-9a39-0298a08f682f` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXPass FrailtyDeviceUsed | `cade5021-b1bf-43e9-a0a4-659c05b386d0` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| IPPass MedicalNutritionTherapy3 | `d3ac0220-8947-489d-b7fe-a199d5365a6f` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| IPPass AnnualWellnessVisit | `da05305e-9c4c-4b1d-ac55-cab089a11d2b` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXPass PalliativeCareInterventionDuringMP | `e2b82999-6313-40af-bc8b-9ddf5f97795f` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass FrailtyDxOverlapsMP | `e61be907-af68-493f-a6bc-3d93ef8b6c6e` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass HospiceDischargeToHomeDuringMP | `eacbadee-87f7-4ed0-bfc3-b5533128dcbc` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass FrailtyDeviceRequestNotPerformedFalse | `ede0ee7a-18ab-4ba7-934c-23618f1270ea` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass PalliativeCareSurveyOverlapsB4MP | `f4eeba51-a6fc-4ffd-bd62-49fd1c375f01` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass FrailtyDxOverlapsMP2 | `f5771b74-a7de-439a-a51f-49a3863e086b` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| IPPass NutritionServices | `f64a63d1-cdc9-4486-a4d5-1d140a4f07e1` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| IPPass InitialOfficeVisit | `fccb9758-ea26-4a1e-98cf-3942102295b8` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |

### CMS122 v1.0.000 vs vendored draft v0.5.000

Using the official v1 Bundle ValueSets as the external cache, 0/55 cases changed population vector; 0 drift errors.

| Case | UUID | Changed populations | v1 IPP/DEN/DENEX/NUM | draft IPP/DEN/DENEX/NUM |
|---|---|---|---|---|
| None | — | — | — | — |

## CMS125 — CMS125FHIRBreastCancerScreen

Measurement period: 2026-01-01 → 2026-12-31. Raw expected agreement 66/66; reference-adjusted pass 66/66.

| Case | UUID | IPP E/A | DENOM E/A | DENEX E/A | NUMER E/A | Result |
|---|---|---:|---:|---:|---:|---|
| DENEXPass HospiceDiagnosisOverlapsMP | `01c88972-84e2-4594-835b-924481b9990a` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass BilateralMastCondEncDxOnDec31OfMP | `05b5981f-0075-462d-ad19-d29f7205d1fa` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXFail 65yoInNursingHomeOnDec31OfMP | `07fb2077-048c-4cb0-ba3e-6e67ed33133d` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXPass HospiceServicesEndOnDec31OfMP | `0930082c-fda1-42e8-a15f-92ceaefa5908` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass HospiceServicesEndOnJan1OfMP | `0beefd14-c554-4f1e-856c-c8696177ce9e` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass DementiaMedsDuringMP | `0ced1e0c-9c92-4582-a4b1-e44f130e436f` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass PalliativeCareObsOnJan1OfMPDuringInterval | `14193177-2f4e-4480-a471-87ff9d137a8b` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass FrailtyCondEncDxOverlapsMP | `14b87edd-7f1e-4f6a-9910-f905966ec904` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| IPFail 75yoWOfficVisEncJan1OfMP | `16b5141f-ec71-499c-a6f1-59b3c390a54a` | 0/0 | 0/0 | 0/0 | 0/0 | PASS |
| DENEXPass FrailtyDeviceRequestNoPerformedModExt | `24557438-17c9-405c-88dc-0c0bfda17d27` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass HospiceDischargeToHomeDuringMP | `2886b1b6-5834-4788-8cd7-b54bbda54ca9` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| IPPass VirtualEnc | `33afc6f6-11c8-4d29-9e2d-cdc292565458` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXPass UniMastRandLProcJan1OfMP | `356ab8ed-7c44-46ec-9fa9-9ec462054f2b` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass PalliativeCareInterventionDuringMP | `3ea0a87a-3ded-4939-920a-4e69bc20a26f` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass HospiceCondEncDiagnosisOverlapsMP | `461f1aab-e645-4973-ae9a-4c09bfaef59a` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXFail 66yoInNursingHomeStatusUnknown | `46fbbd0e-d175-4203-97bb-fe616cd2ab77` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| IPPass PreventiveCareEstablishedVisit | `473f9149-c7f0-4979-8924-9534cabe5117` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXPass RightAndLeftMastDxDec31OfMP | `4827b310-b012-4b0e-8a7d-572103c65892` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass BilateralMastProcOnDec31OfMP | `4cf81a94-81fb-4be2-b075-7d8f9ff02a6e` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass HospiceEncOverlapsMP | `4f10a0f7-bb14-40d5-beb2-c728eb88a30d` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass BilateralMastDxOnDec31OfMP | `4fa225f9-836c-4304-95a2-5b9d6d4ff9c7` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXFail HospiceServicesEndOnDec31B4MP | `57d8d494-e828-4edf-8c8b-e27da33ea223` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| IPPass TelephoneVisit | `591e960d-b937-41f3-9817-56cf201a06db` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| IPPass 74yoWOfficeVisEncDec31OfMP | `5be43868-ffec-4de5-b99e-185513b74c82` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXPass PalliativeCareCondEncDiagnosisDuringMP | `5c8bffdf-7ef4-44e1-af5a-8a64f1b7e545` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass FrailtyDxOverlapsMP | `5e3f01ad-1eda-4cb7-8d37-1146beae59e9` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass PalliativeCareObsOnDec31OfMPDuringInterval | `5fd02264-fd4e-4eb7-a635-0023876920ac` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| NUMPass MammogramOct1DuringInterval | `6226b04f-5e2d-4977-9169-8e9451ffa939` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXPass AdvIllnessDxWithin2Yrs | `62901c95-5d12-45e8-b5b1-d131e36d8299` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXFail UniMastRightProcOnJan1AfterMP | `633c26f2-9c7a-4eaf-b983-83b9e13656ac` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXFail UniMastDxRQualOnJan1AfterMP | `68067d39-5287-40dd-ba97-c2aa1bf46d78` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| IPPass HomeHealthcare | `6b2e313f-6139-45fa-8e18-cc2f0b908981` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXFail 66yoInNursingHomeOnJan1AfterInterval | `6fc33313-98bc-460e-9e38-9240dcbd111a` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXPass PalliativeCareDiagnosisDuringMP | `73f77133-4d08-438a-ac81-6bb858a74c31` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass 66yoInNursingHomeOnDec31OfMP | `7a09940e-c3c8-49a7-bf09-eaf9df116dfb` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass UniMastDxRandLQualOnJan1OfMP | `7e5d94fa-3630-43b6-9b6e-b75c0fba7cd0` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| NUMPass MammogramDec31OfMPDuringInterval | `81dce125-8691-4625-ac6b-07fce0a45680` | 1/1 | 1/1 | 0/0 | 1/1 | PASS |
| DENEXPass FrailtyObsDuringMP | `8278ae07-69ec-469c-ae01-e933d051f764` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass UniMastRandLProcDec31OfMP | `857fec09-9c8c-4e4b-a123-85f473b8fc2a` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| IPFail 42yoWOfficeVisEncJan1YrAfterMP | `87f00b2a-f664-4b82-843e-559bf1f86520` | 0/0 | 0/0 | 0/0 | 0/0 | PASS |
| DENEXPass AdvIllnessCondEncDxWithin2Yrs | `8a0f6b6e-fb1c-4e60-b150-b88d1a4e487b` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| IPFail 42yoWOfficeVisEncDec31YrB4MP | `8f459050-c870-4719-9952-80baa25d1fa1` | 0/0 | 0/0 | 0/0 | 0/0 | PASS |
| IPFail 41yoWOfficeVisEncJan1OfMP | `94220a48-4424-4040-91bf-9c16bf3368dd` | 0/0 | 0/0 | 0/0 | 0/0 | PASS |
| DENEXPass HospiceProcedureStartsDuringMP | `99b68a44-5e66-4c37-a513-80db8b6249ce` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| SDEFail SDECoverage2 | `acc6f85b-14ad-4daa-8981-66c1c37c8f07` | 0/0 | 0/0 | 0/0 | 0/0 | PASS |
| DENEXPass PalliativeCareEncounterDuringMP | `adb08da2-b4d0-4916-9b9c-7c2c86e1042b` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| SDEFail SDECoverage | `aec15569-ccd3-4c5c-8e46-2bec68c03e72` | 0/0 | 0/0 | 0/0 | 0/0 | PASS |
| DENEXFail RightMastDxJan1AfterMP | `b528b1a6-cd8d-4f66-83c2-6467e83b6996` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXPass HospiceObsValueIsYes | `bbb391da-9572-4954-be95-3ea00eb31c91` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| IPPass PreventiveCareInitialVisit | `bea75baa-41f5-4755-9986-15c2bba658d5` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| IPPass 42yoWOfficeVisEncJan1OfMP | `c32eb7d1-eac5-458e-b965-c717620579a2` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXPass UniMastCondEncDxRandLQualOnJan1OfMP | `c6897181-bb69-4bda-a44d-7c07cf81fc1b` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass HospiceServiceRequestDuringMP | `cc1a4555-2e3e-43ac-bbca-6e44ea41b2f3` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXFail AdvIllnessDxBefore2Yrs | `cf727fca-40bc-46ed-b97b-e9021cffb8d3` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXPass FrailtyDeviceRequestNotPerformedFalse | `d4540640-2561-4ebd-b7c6-15878a4dc582` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXPass FrailtyEncOverlapsMP | `da85601e-ce6f-4351-b639-1e58c725bf2f` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXFail HospiceServicesEndOnJan1AfterMP | `dd6bd96f-3a4e-4796-bee0-1d31884e96d7` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| IPPass AnnualWellnessVisit | `deb40976-ede4-4657-8af8-078369fa65f4` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXFail BilateralMastProcOnJan1AfterMP | `defc50ff-2898-4ab0-ac06-75eae73bc6fa` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXFail PalliativeCareObsOnJan1AfterInterval | `f2f748c2-321f-4c05-896a-2ef9d925eaf9` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXPass FrailtySymptomOverlapsMP | `f38ce16a-658f-4aa0-b4a6-fac61d2e58a8` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| NUMFail MammogramJan1AfterInterval | `f4d00e60-e525-4644-a397-4d7d970bcfdb` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| NUMFail MammogramSep30B4Interval | `f7574a1c-122e-45ef-9ab5-cfa35a40d6d6` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXPass RightAndLeftMastCondEncDxDec31OfMP | `f887d498-35c1-41e4-85f5-288b52895140` | 1/1 | 1/1 | 1/1 | 0/0 | PASS |
| DENEXFail BilateralMastDxOnJan1AfterMP | `f9de4c72-b2ed-4c8f-94fe-8c934e42e0a0` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |
| DENEXFail PalliativeCareObsOnDec31B4Interval | `ffbb03e1-7188-42ef-8deb-c6cf3f790bfe` | 1/1 | 1/1 | 0/0 | 0/0 | PASS |

## Interpretation rules

- `PASS` = exact agreement with the committed MADiE expected population counts.
- `PASS†` = exact agreement with the source repository's reference-engine discrepancy for one of the six known-bad CMS122 numerator expecteds.
- `FAIL` = unexpected population mismatch requiring case-level investigation.
- `ERROR` = loader or calculation failure; it is not counted as an agreement or an engine mismatch.
- Expansion caps are reported independently. They are only assigned as a cause when a mismatched case actually depends on a code absent from the capped expansion.

The downloaded source content remains local under `backend-ts/.official-content/` and is not committed.
