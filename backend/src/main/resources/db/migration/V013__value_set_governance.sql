-- Extend value_sets with governance/terminology fields
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS canonical_url TEXT;
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS code_systems TEXT[] DEFAULT '{}';
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS expansion_hash TEXT;
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS resolution_status TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS resolution_error TEXT;

-- Demo value sets (fixed UUIDs for stable seeding and linking)
INSERT INTO value_sets (id, oid, name, version, codes_json, last_resolved_at,
    canonical_url, code_systems, source, status, resolution_status, expansion_hash)
VALUES
  ('a0000001-0000-0000-0000-000000000001',
   'urn:workwell:vs:audiogram-procedure-codes',
   'Audiogram Procedure Codes', '2025-demo',
   '[{"code":"LOCAL-AUD-001","display":"Baseline audiogram","system":"urn:workwell:demo"},
     {"code":"LOCAL-AUD-002","display":"Annual audiogram evaluation","system":"urn:workwell:demo"},
     {"code":"LOCAL-AUD-003","display":"Audiometric test pure tone","system":"urn:workwell:demo"},
     {"code":"92557","display":"Comprehensive audiometry evaluation","system":"http://www.ama-assn.org/go/cpt"}]'::jsonb,
   NOW(), NULL,
   ARRAY['urn:workwell:demo','http://www.ama-assn.org/go/cpt'],
   'WorkWell Demo', 'ACTIVE', 'RESOLVED', 'demo-hash-aud-v1'),

  ('a0000001-0000-0000-0000-000000000002',
   'urn:workwell:vs:tb-screen-codes',
   'TB Screening Procedure Codes', '2025-demo',
   '[{"code":"LOCAL-TB-001","display":"PPD skin test placement","system":"urn:workwell:demo"},
     {"code":"LOCAL-TB-002","display":"TB IGRA blood test","system":"urn:workwell:demo"},
     {"code":"86580","display":"Intradermal skin test","system":"http://www.ama-assn.org/go/cpt"}]'::jsonb,
   NOW(), NULL,
   ARRAY['urn:workwell:demo','http://www.ama-assn.org/go/cpt'],
   'WorkWell Demo', 'ACTIVE', 'RESOLVED', 'demo-hash-tb-v1'),

  ('a0000001-0000-0000-0000-000000000003',
   'urn:workwell:vs:hazwoper-clearance-codes',
   'HAZWOPER Medical Clearance Codes', '2025-demo',
   '[{"code":"LOCAL-HAZ-001","display":"HAZWOPER medical surveillance exam","system":"urn:workwell:demo"},
     {"code":"LOCAL-HAZ-002","display":"Annual fitness-for-duty evaluation","system":"urn:workwell:demo"}]'::jsonb,
   NOW(), NULL,
   ARRAY['urn:workwell:demo'],
   'WorkWell Demo', 'ACTIVE', 'RESOLVED', 'demo-hash-haz-v1'),

  ('a0000001-0000-0000-0000-000000000004',
   'urn:workwell:vs:flu-vaccine-codes',
   'Influenza Vaccine Immunization Codes', '2025-demo',
   '[{"code":"88","display":"Influenza virus vaccine unspecified","system":"http://hl7.org/fhir/sid/cvx"},
     {"code":"141","display":"Influenza seasonal injectable","system":"http://hl7.org/fhir/sid/cvx"},
     {"code":"LOCAL-FLU-001","display":"Flu vaccine administered","system":"urn:workwell:demo"}]'::jsonb,
   NOW(), NULL,
   ARRAY['http://hl7.org/fhir/sid/cvx','urn:workwell:demo'],
   'WorkWell Demo', 'ACTIVE', 'RESOLVED', 'demo-hash-flu-v1')
ON CONFLICT (oid, version) DO NOTHING;

-- Local-to-standard terminology mappings table
CREATE TABLE IF NOT EXISTS terminology_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_code TEXT NOT NULL,
  local_display TEXT,
  local_system TEXT NOT NULL,
  standard_code TEXT NOT NULL,
  standard_display TEXT,
  standard_system TEXT NOT NULL,
  mapping_status TEXT NOT NULL,
  mapping_confidence NUMERIC,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  notes TEXT,
  UNIQUE(local_system, local_code, standard_system, standard_code)
);

-- Demo terminology mappings
INSERT INTO terminology_mappings (
  local_code, local_display, local_system,
  standard_code, standard_display, standard_system,
  mapping_status, mapping_confidence, reviewed_by, reviewed_at, notes)
VALUES
  ('LOCAL-AUD-001', 'Baseline audiogram', 'urn:workwell:demo',
   '92557', 'Comprehensive audiometry evaluation', 'http://www.ama-assn.org/go/cpt',
   'APPROVED', 0.90, 'occupational-health-team', NOW(),
   'Demo mapping — CPT 92557 accepted for annual audiogram compliance'),

  ('LOCAL-TB-001', 'PPD skin test placement', 'urn:workwell:demo',
   '86580', 'Intradermal skin test', 'http://www.ama-assn.org/go/cpt',
   'APPROVED', 0.85, 'occupational-health-team', NOW(),
   'Demo mapping — CPT 86580 accepted for TB PPD placement'),

  ('LOCAL-FLU-001', 'Flu vaccine administered', 'urn:workwell:demo',
   '141', 'Influenza seasonal injectable', 'http://hl7.org/fhir/sid/cvx',
   'APPROVED', 0.95, 'occupational-health-team', NOW(),
   'Demo mapping — CVX 141 accepted for seasonal flu vaccine'),

  ('LOCAL-HAZ-001', 'HAZWOPER medical surveillance exam', 'urn:workwell:demo',
   'LOCAL-HAZ-CLEARANCE', 'HAZWOPER annual clearance', 'urn:workwell:standard',
   'REVIEWED', 0.80, NULL, NULL,
   'Demo mapping — internal standard, no external equivalent yet'),

  ('LOCAL-TB-002', 'TB IGRA blood test', 'urn:workwell:demo',
   '86480', 'Tuberculosis cell-mediated immunity test', 'http://www.ama-assn.org/go/cpt',
   'PROPOSED', 0.75, NULL, NULL,
   'Demo proposed mapping — awaiting clinical review')
ON CONFLICT (local_system, local_code, standard_system, standard_code) DO NOTHING;
