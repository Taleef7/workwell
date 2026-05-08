CREATE TABLE IF NOT EXISTS waivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES employees(id),
    measure_id UUID NOT NULL REFERENCES measures(id),
    measure_version_id UUID NOT NULL REFERENCES measure_versions(id),
    exclusion_reason TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    notes TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS waivers_employee_measure_version_idx
    ON waivers (employee_id, measure_version_id, active, granted_at DESC);

CREATE INDEX IF NOT EXISTS waivers_measure_idx
    ON waivers (measure_id, active, expires_at);
