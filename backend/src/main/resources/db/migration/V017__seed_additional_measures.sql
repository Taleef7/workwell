-- V017__seed_additional_measures.sql
-- Add three additional catalog measures (Draft, Approved, Deprecated) to enrich the
-- measure catalog to match the v0 prototype (7+ measures in varied lifecycle states).
-- Idempotent: skips insert when measure name already exists.

-- 1. Respirator Fit Test — Draft v0.9
DO $$
DECLARE v_measure_id UUID;
BEGIN
    SELECT id INTO v_measure_id FROM measures WHERE name = 'Respirator Fit Test';
    IF v_measure_id IS NULL THEN
        v_measure_id := gen_random_uuid();
        INSERT INTO measures (id, name, policy_ref, owner, tags, created_at, updated_at)
        VALUES (
            v_measure_id,
            'Respirator Fit Test',
            'OSHA 29 CFR 1910.134',
            'J. Chen',
            ARRAY['surveillance','respiratory','osha'],
            NOW() - INTERVAL '30 days',
            NOW() - INTERVAL '5 days'
        );

        INSERT INTO measure_versions (
            id, measure_id, version, status, spec_json, cql_text,
            compile_status, change_summary, created_at
        ) VALUES (
            gen_random_uuid(),
            v_measure_id,
            'v0.9',
            'DRAFT',
            '{
                "description": "Annual medical evaluation and fit test for employees required to use respiratory protection under OSHA 1910.134.",
                "eligibilityCriteria": {
                    "roleFilter": "Maintenance Tech, Paint Crew, Chemical Handler",
                    "siteFilter": "Plant A, Plant B",
                    "programEnrollmentText": "Enrolled in Respiratory Protection Program"
                },
                "exclusions": [{"label": "Medical Clearance Waiver", "criteriaText": "Physician-issued respirator clearance waiver on file"}],
                "complianceWindow": "365 days from last fit test",
                "requiredDataElements": ["Respirator Type", "Last Fit Test Date", "Medical Clearance Status"]
            }'::jsonb,
            NULL,
            'NOT_COMPILED',
            'Initial draft from OSHA 1910.134 requirements',
            NOW() - INTERVAL '5 days'
        );
    END IF;
END $$;

-- 2. Hepatitis B Vaccination Series — Approved v2.0
DO $$
DECLARE v_measure_id UUID;
BEGIN
    SELECT id INTO v_measure_id FROM measures WHERE name = 'Hepatitis B Vaccination Series';
    IF v_measure_id IS NULL THEN
        v_measure_id := gen_random_uuid();
        INSERT INTO measures (id, name, policy_ref, owner, tags, created_at, updated_at)
        VALUES (
            v_measure_id,
            'Hepatitis B Vaccination Series',
            'OSHA 29 CFR 1910.1030',
            'K. Williams',
            ARRAY['vaccine','bbp','osha'],
            NOW() - INTERVAL '12 months',
            NOW() - INTERVAL '2 months'
        );

        INSERT INTO measure_versions (
            id, measure_id, version, status, spec_json, cql_text,
            compile_status, approved_by, change_summary, created_at
        ) VALUES (
            gen_random_uuid(),
            v_measure_id,
            'v2.0',
            'APPROVED',
            '{
                "description": "Hepatitis B vaccination series completion for employees with occupational exposure to blood or other potentially infectious materials.",
                "eligibilityCriteria": {
                    "roleFilter": "Nurse, Lab Technician, Phlebotomist, Emergency Responder",
                    "siteFilter": "Clinic, Medical Center",
                    "programEnrollmentText": "Bloodborne pathogen exposure risk role"
                },
                "exclusions": [{"label": "Documented Immunity", "criteriaText": "Positive anti-HBs titer on file"}],
                "complianceWindow": "Series of 3 doses over 6 months",
                "requiredDataElements": ["HBV Dose 1 Date", "HBV Dose 2 Date", "HBV Dose 3 Date", "Anti-HBs Titer Result"]
            }'::jsonb,
            '-- Hepatitis B CQL placeholder pending value set finalization',
            'COMPILED',
            'Dr. R. Patel (Medical Director)',
            'v2.0: updated eligibility criteria to include Emergency Responders',
            NOW() - INTERVAL '2 months'
        );
    END IF;
END $$;

-- 3. Lead Medical Surveillance — Deprecated v1.1
DO $$
DECLARE v_measure_id UUID;
BEGIN
    SELECT id INTO v_measure_id FROM measures WHERE name = 'Lead Medical Surveillance';
    IF v_measure_id IS NULL THEN
        v_measure_id := gen_random_uuid();
        INSERT INTO measures (id, name, policy_ref, owner, tags, created_at, updated_at)
        VALUES (
            v_measure_id,
            'Lead Medical Surveillance',
            'OSHA 29 CFR 1910.1025',
            'M. Patel',
            ARRAY['surveillance','lead','osha'],
            NOW() - INTERVAL '24 months',
            NOW() - INTERVAL '6 months'
        );

        INSERT INTO measure_versions (
            id, measure_id, version, status, spec_json,
            compile_status, change_summary, approved_by, created_at
        ) VALUES (
            gen_random_uuid(),
            v_measure_id,
            'v1.1',
            'DEPRECATED',
            '{
                "description": "DEPRECATED — Replaced by updated Lead Exposure Monitoring Protocol. Blood lead level monitoring for employees exposed to lead above the action level.",
                "eligibilityCriteria": {
                    "roleFilter": "Battery Plant Worker, Smelter, Lead Paint Handler",
                    "siteFilter": "Plant A",
                    "programEnrollmentText": "Lead exposure above action level (30 µg/m³)"
                },
                "exclusions": [],
                "complianceWindow": "Every 6 months for blood lead monitoring",
                "requiredDataElements": ["Blood Lead Level (µg/dL)", "Exam Date"]
            }'::jsonb,
            'COMPILED',
            'Deprecated — superseded by updated OSHA interpretations in 2024',
            'Dr. R. Patel (Medical Director)',
            NOW() - INTERVAL '6 months'
        );
    END IF;
END $$;
