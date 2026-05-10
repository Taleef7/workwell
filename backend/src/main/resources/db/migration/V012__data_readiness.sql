CREATE TABLE IF NOT EXISTS integration_sources (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    status TEXT NOT NULL,
    last_sync_at TIMESTAMPTZ,
    last_successful_sync_at TIMESTAMPTZ,
    last_error TEXT,
    config_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS data_element_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id TEXT NOT NULL REFERENCES integration_sources(id),
    canonical_element TEXT NOT NULL,
    source_field TEXT NOT NULL,
    fhir_resource_type TEXT,
    fhir_path TEXT,
    code_system TEXT,
    mapping_status TEXT NOT NULL DEFAULT 'MAPPED',
    last_validated_at TIMESTAMPTZ,
    notes TEXT,
    UNIQUE(source_id, canonical_element)
);

CREATE TABLE IF NOT EXISTS data_readiness_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    measure_version_id UUID REFERENCES measure_versions(id),
    run_id UUID REFERENCES runs(id),
    snapshot_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    overall_status TEXT NOT NULL,
    payload_json JSONB NOT NULL
);

-- Seed integration sources (mirrors integration_health IDs)
INSERT INTO integration_sources (id, display_name, source_type, status, config_json) VALUES
    ('hris', 'HRIS', 'INTERNAL', 'HEALTHY', '{"provider":"workwell-demo","syncMode":"batch"}'::jsonb),
    ('fhir', 'FHIR Repository', 'FHIR_R4', 'HEALTHY', '{"version":"R4","mode":"in-memory"}'::jsonb),
    ('ai',   'AI Service',      'OPENAI',   'UNKNOWN', '{}'::jsonb),
    ('mcp',  'MCP Server',      'MCP_SSE',  'UNKNOWN', '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Seed data element mappings covering all four demo measures
INSERT INTO data_element_mappings (source_id, canonical_element, source_field, fhir_resource_type, fhir_path, mapping_status, notes) VALUES
    -- HRIS-sourced employee attributes (shared across all measures)
    ('hris', 'employee.role', 'employee_role', NULL, NULL, 'MAPPED',
        'Employee job role; used for eligibility filtering across all measures'),
    ('hris', 'employee.site', 'employee_site', NULL, NULL, 'MAPPED',
        'Employee work site; used for site-level eligibility filters'),

    -- Program enrollment flags per measure
    ('hris', 'programEnrollment.hearingConservation', 'program_enrollments[hearing_conservation]', NULL, NULL, 'MAPPED',
        'Audiogram eligibility flag'),
    ('hris', 'programEnrollment.hazwoper',            'program_enrollments[hazwoper]',             NULL, NULL, 'MAPPED',
        'HAZWOPER surveillance eligibility flag'),
    ('hris', 'programEnrollment.tbScreening',         'program_enrollments[tb_screening]',         NULL, NULL, 'MAPPED',
        'TB screening eligibility flag'),
    ('hris', 'programEnrollment.clinicalFacing',      'program_enrollments[clinical_facing]',      NULL, NULL, 'MAPPED',
        'Flu vaccine eligibility flag'),

    -- Waiver / exemption flags
    ('hris', 'waiver.hearingConservation', 'waivers[hearing_conservation]', NULL, NULL, 'MAPPED',
        'Active hearing conservation waiver'),
    ('hris', 'waiver.medical',             'waivers[medical]',              NULL, NULL, 'MAPPED',
        'Active medical exemption (TB, HAZWOPER)'),
    ('hris', 'waiver.flu',                 'waivers[flu]',                  NULL, NULL, 'MAPPED',
        'Flu vaccine contraindication flag'),

    -- FHIR-sourced clinical procedure / immunization dates
    ('fhir', 'procedure.audiogram',
        'Procedure.performedDateTime', 'Procedure',
        'Procedure.where(code in audiogram-vs).performedDateTime',
        'MAPPED', 'Most recent audiogram procedure date'),
    ('fhir', 'procedure.hazwoperExam',
        'Procedure.performedDateTime', 'Procedure',
        'Procedure.where(code in hazwoper-vs).performedDateTime',
        'MAPPED', 'Most recent HAZWOPER medical surveillance exam date'),
    ('fhir', 'procedure.tbScreen',
        'Procedure.performedDateTime', 'Procedure',
        'Procedure.where(code in tb-vs).performedDateTime',
        'MAPPED', 'Most recent TB screening date'),
    ('fhir', 'procedure.fluVaccine',
        'Immunization.occurrenceDateTime', 'Immunization',
        'Immunization.where(vaccineCode in flu-vs).occurrenceDateTime',
        'MAPPED', 'Current season flu vaccine date'),

    -- Policy / calendar
    ('hris', 'policy.fluSeason', 'flu_season_config', NULL, NULL, 'MAPPED',
        'Current flu season start/end window from site policy config')
ON CONFLICT (source_id, canonical_element) DO NOTHING;
