CREATE TABLE IF NOT EXISTS scheduled_appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    employee_id UUID NOT NULL REFERENCES employees(id),
    measure_id UUID NOT NULL REFERENCES measures(id),
    appointment_type TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    location TEXT NOT NULL,
    status TEXT NOT NULL,
    notes TEXT,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outreach_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    template_name TEXT,
    auto_triggered BOOLEAN NOT NULL DEFAULT FALSE,
    payload_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
