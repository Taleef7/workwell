CREATE TABLE IF NOT EXISTS osha_references (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cfr_citation TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    program_area TEXT NOT NULL
);

ALTER TABLE measure_versions
    ADD COLUMN IF NOT EXISTS osha_reference_id UUID REFERENCES osha_references(id);

CREATE INDEX IF NOT EXISTS measure_versions_osha_reference_id_idx
    ON measure_versions (osha_reference_id);

INSERT INTO osha_references (cfr_citation, title, program_area)
VALUES
    ('29 CFR 1910.95', 'Occupational Noise Exposure', 'Hearing Conservation'),
    ('29 CFR 1910.1030', 'Bloodborne Pathogens', 'Infection Control'),
    ('29 CFR 1910.134', 'Respiratory Protection', 'Respiratory Protection'),
    ('29 CFR 1910.1020', 'Access to Employee Exposure and Medical Records', 'Medical Records'),
    ('29 CFR 1910.120', 'Hazardous Waste Operations and Emergency Response', 'Hazardous Materials'),
    ('29 CFR 1910.1096', 'Ionizing Radiation', 'Radiation Safety'),
    ('29 CFR 1904', 'Recording and Reporting Occupational Injuries and Illnesses', 'Recordkeeping'),
    ('29 CFR 1910.269', 'Electric Power Generation, Transmission, and Distribution', 'Utility Operations')
ON CONFLICT (cfr_citation) DO NOTHING;

UPDATE measure_versions mv
SET osha_reference_id = osha_ref.id
FROM measures m
JOIN osha_references osha_ref
    ON LOWER(osha_ref.cfr_citation) = LOWER(REGEXP_REPLACE(COALESCE(m.policy_ref, ''), '^OSHA[[:space:]]+', '', 'i'))
    OR LOWER(osha_ref.title) = LOWER(COALESCE(m.policy_ref, ''))
    OR LOWER(CONCAT(osha_ref.cfr_citation, ' — ', osha_ref.title)) = LOWER(COALESCE(m.policy_ref, ''))
WHERE mv.measure_id = m.id
  AND mv.osha_reference_id IS NULL;
