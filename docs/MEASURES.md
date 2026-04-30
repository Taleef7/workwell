# WorkWell Demo Measures (Plain-English Specs)

This document defines four MVP demo measures in plain English so they can later be translated into CQL.

## 1) Annual Audiogram Completed
- Policy reference: OSHA 29 CFR 1910.95 (Occupational Noise Exposure)  
  URL: https://www.ecfr.gov/current/title-29/section-1910.95
- Initial population: all active employees in scoped sites.
- Denominator: employees enrolled in hearing conservation program or with documented TWA noise exposure >= 85 dBA.
- Exclusions: active documented medical waiver/exemption for audiometric testing.
- Numerator: at least one completed audiogram procedure in the last 365 days.
- Outcomes: compliant <= 335 days since last test; due-soon 336-365; overdue > 365; missing data when enrollment/exposure exists but test date cannot be evaluated.
- Likely FHIR resources: Patient, Observation (exposure), Procedure (audiogram), Condition/DocumentReference (waiver).
- Example scenarios:
  - Compliant: enrolled worker with audiogram 120 days ago -> Compliant.
  - Overdue: enrolled worker with last audiogram 420 days ago -> Overdue.
  - Excluded: enrolled worker with active waiver letter -> Excluded.
- CQL edge notes: noise-threshold coding variance; waiver validity windows; timezone-safe day math.

## 2) Annual Medical Surveillance Exam (HAZWOPER)
- Policy reference: OSHA 29 CFR 1910.120 (HAZWOPER)  
  URL: https://www.ecfr.gov/current/title-29/section-1910.120
- Initial population: all active employees in scoped sites.
- Denominator: workers assigned to HAZWOPER program/roles.
- Exclusions: none for MVP.
- Numerator: comprehensive surveillance/physical exam encounter within the past 12 months.
- Outcomes: compliant <= 335 days; due-soon 336-365; overdue > 365; missing data when role assignment exists but exam evidence is incomplete.
- Likely FHIR resources: Patient, Encounter, Procedure, Condition (program enrollment).
- Example scenarios:
  - Compliant: HAZWOPER tech with exam 200 days ago -> Compliant.
  - Overdue: HAZWOPER responder with exam 390 days ago -> Overdue.
  - Missing data: worker marked HAZWOPER but exam document has no valid date -> Missing Data.
- CQL edge notes: role-to-program mapping source of truth; encounter vs procedure precedence.

## 3) Annual TB Screening
- Policy reference: CDC TB screening guidance + organization policy  
  URL: https://www.cdc.gov/tb/topic/testing/healthcareworkers.htm
- Initial population: all active employees in scoped sites.
- Denominator: high-risk roles requiring annual TB screening.
- Exclusions: approved long-term exemption (if policy supports).
- Numerator: one of: TB skin test, IGRA blood test, or symptom screen in past 12 months.
- Outcomes: compliant <= 335 days; due-soon 336-365; overdue > 365; missing data when role is eligible but none of the three pathways is evaluable.
- Likely FHIR resources: Patient, Observation, Procedure, QuestionnaireResponse, Condition/DocumentReference (exemption).
- Example scenarios:
  - Compliant: nurse with IGRA result 80 days ago -> Compliant.
  - Overdue: clinician with last TB skin test 500 days ago -> Overdue.
  - Excluded: employee with approved permanent exemption -> Excluded.
- CQL edge notes: OR-logic across modalities; equivalent code systems; duplicated tests in same period.

## 4) Flu Vaccine This Season
- Policy reference: organization policy (seasonal immunization) informed by CDC flu guidance  
  URL: https://www.cdc.gov/flu/professionals/vaccination/
- Initial population: all active employees in scoped sites.
- Denominator: clinical-facing employees (or all employees, based on final policy toggle).
- Exclusions: documented medical or religious exemption if policy allows.
- Numerator: at least one flu immunization recorded during current season window (Sep 1-Apr 30, local policy timezone).
- Outcomes: compliant if vaccine exists in current season; due-soon in final 30 days of season for unvaccinated; overdue after season cutoff; missing data when denominator eligibility exists but immunization source is unavailable.
- Likely FHIR resources: Patient, Immunization, Condition/DocumentReference (exemption), Organization/Location (site scoping).
- Example scenarios:
  - Compliant: vaccinated on Oct 10 of current season -> Compliant.
  - Overdue: no vaccination by season close -> Overdue.
  - Excluded: valid exemption on file for current season -> Excluded.
- CQL edge notes: season boundary crossing calendar years; site-specific season rules; handling externally reported vaccines.
