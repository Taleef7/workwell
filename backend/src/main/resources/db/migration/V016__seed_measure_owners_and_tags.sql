-- V016__seed_measure_owners_and_tags.sql
-- Update seeded measure owners to realistic OH team personas and assign proper tags.
-- Safe to re-run: uses explicit WHERE on known measure names from ensureXxxSeed().

UPDATE measures SET owner = 'J. Chen', tags = ARRAY['surveillance','hearing','osha']
WHERE name = 'Audiogram';

UPDATE measures SET owner = 'M. Patel', tags = ARRAY['surveillance','hazmat','osha']
WHERE name = 'HAZWOPER Surveillance';

UPDATE measures SET owner = 'K. Williams', tags = ARRAY['surveillance','infection-control','cdc']
WHERE name = 'TB Surveillance';

UPDATE measures SET owner = 'K. Williams', tags = ARRAY['vaccine','seasonal','immunization']
WHERE name = 'Flu Vaccine';

-- Update approved_by on active versions to the medical director persona
UPDATE measure_versions mv
SET approved_by = 'Dr. R. Patel (Medical Director)'
FROM measures m
WHERE mv.measure_id = m.id
  AND m.name IN ('Audiogram', 'HAZWOPER Surveillance', 'TB Surveillance', 'Flu Vaccine')
  AND mv.status = 'ACTIVE';
