-- Seed demo test fixtures for the 4 active measures.
-- Fixtures are stored inside spec_json->'testFixtures' on each measure_version row.
-- Only updates rows where testFixtures is currently empty (idempotent).

-- Audiogram: covers COMPLIANT, DUE_SOON, OVERDUE, MISSING_DATA, EXCLUDED
UPDATE measure_versions
SET spec_json = jsonb_set(
    spec_json,
    '{testFixtures}',
    '[
      {"fixtureName": "Compliant — audiogram within annual window", "employeeExternalId": "emp-001", "expectedOutcome": "COMPLIANT", "notes": "120 days since last exam; threshold 335 days"},
      {"fixtureName": "Due soon — audiogram approaching due date", "employeeExternalId": "emp-002", "expectedOutcome": "DUE_SOON", "notes": "350 days since last exam; DUE_SOON window 336–365"},
      {"fixtureName": "Overdue — annual audiogram past due", "employeeExternalId": "emp-003", "expectedOutcome": "OVERDUE", "notes": "420 days since last exam; threshold 365 days"},
      {"fixtureName": "Missing data — no audiogram on record", "employeeExternalId": "emp-004", "expectedOutcome": "MISSING_DATA", "notes": "No exam date present in employee record"},
      {"fixtureName": "Excluded — active audiogram waiver on file", "employeeExternalId": "emp-005", "expectedOutcome": "EXCLUDED", "notes": "Valid waiver exempts from annual requirement"}
    ]'::jsonb
)
WHERE measure_id IN (SELECT id FROM measures WHERE name = 'Audiogram')
  AND status = 'Active'
  AND (spec_json -> 'testFixtures' IS NULL
       OR jsonb_array_length(COALESCE(spec_json -> 'testFixtures', '[]'::jsonb)) = 0);

-- HAZWOPER Surveillance: covers COMPLIANT, DUE_SOON, OVERDUE, MISSING_DATA, EXCLUDED
UPDATE measure_versions
SET spec_json = jsonb_set(
    spec_json,
    '{testFixtures}',
    '[
      {"fixtureName": "Compliant — HAZWOPER surveillance current", "employeeExternalId": "emp-003", "expectedOutcome": "COMPLIANT", "notes": "120 days since HAZWOPER exam; threshold 335 days"},
      {"fixtureName": "Due soon — HAZWOPER surveillance approaching", "employeeExternalId": "emp-008", "expectedOutcome": "DUE_SOON", "notes": "355 days since exam; DUE_SOON window 335–365"},
      {"fixtureName": "Overdue — HAZWOPER surveillance past due", "employeeExternalId": "emp-013", "expectedOutcome": "OVERDUE", "notes": "380 days since exam; threshold 365 days"},
      {"fixtureName": "Missing data — no HAZWOPER exam on record", "employeeExternalId": "emp-018", "expectedOutcome": "MISSING_DATA", "notes": "No surveillance exam date in employee record"},
      {"fixtureName": "Excluded — HAZWOPER medical exemption on file", "employeeExternalId": "emp-023", "expectedOutcome": "EXCLUDED", "notes": "Medical exemption exempts from annual requirement"}
    ]'::jsonb
)
WHERE measure_id IN (SELECT id FROM measures WHERE name = 'HAZWOPER Surveillance')
  AND status = 'Active'
  AND (spec_json -> 'testFixtures' IS NULL
       OR jsonb_array_length(COALESCE(spec_json -> 'testFixtures', '[]'::jsonb)) = 0);

-- TB Surveillance: covers COMPLIANT, DUE_SOON, OVERDUE, MISSING_DATA, EXCLUDED
UPDATE measure_versions
SET spec_json = jsonb_set(
    spec_json,
    '{testFixtures}',
    '[
      {"fixtureName": "Compliant — TB screen within annual window", "employeeExternalId": "emp-041", "expectedOutcome": "COMPLIANT", "notes": "120 days since last TB screen; threshold 330 days"},
      {"fixtureName": "Due soon — TB screen approaching due date", "employeeExternalId": "emp-045", "expectedOutcome": "DUE_SOON", "notes": "365 days since last screen; DUE_SOON window 330–365"},
      {"fixtureName": "Overdue — TB screen past due", "employeeExternalId": "emp-046", "expectedOutcome": "OVERDUE", "notes": "380 days since last screen; threshold 365 days"},
      {"fixtureName": "Missing data — no TB screen on record", "employeeExternalId": "emp-049", "expectedOutcome": "MISSING_DATA", "notes": "No TB screen date in employee record"},
      {"fixtureName": "Excluded — TB medical exemption on file", "employeeExternalId": "emp-050", "expectedOutcome": "EXCLUDED", "notes": "Medical exemption exempts from TB screening requirement"}
    ]'::jsonb
)
WHERE measure_id IN (SELECT id FROM measures WHERE name = 'TB Surveillance')
  AND status = 'Active'
  AND (spec_json -> 'testFixtures' IS NULL
       OR jsonb_array_length(COALESCE(spec_json -> 'testFixtures', '[]'::jsonb)) = 0);

-- Flu Vaccine: covers COMPLIANT, MISSING_DATA, EXCLUDED
-- Note: DUE_SOON and OVERDUE map to MISSING_DATA in the current Flu Vaccine CQL definition.
UPDATE measure_versions
SET spec_json = jsonb_set(
    spec_json,
    '{testFixtures}',
    '[
      {"fixtureName": "Compliant — flu vaccine documented this season", "employeeExternalId": "emp-001", "expectedOutcome": "COMPLIANT", "notes": "Vaccine administered within the current flu season window"},
      {"fixtureName": "Missing data — no flu vaccine record found", "employeeExternalId": "emp-021", "expectedOutcome": "MISSING_DATA", "notes": "No vaccine record present; employee is clinical-facing and not exempt"},
      {"fixtureName": "Excluded — documented vaccine contraindication", "employeeExternalId": "emp-032", "expectedOutcome": "EXCLUDED", "notes": "Valid medical contraindication exempts from flu vaccine requirement"}
    ]'::jsonb
)
WHERE measure_id IN (SELECT id FROM measures WHERE name = 'Flu Vaccine')
  AND status = 'Active'
  AND (spec_json -> 'testFixtures' IS NULL
       OR jsonb_array_length(COALESCE(spec_json -> 'testFixtures', '[]'::jsonb)) = 0);
