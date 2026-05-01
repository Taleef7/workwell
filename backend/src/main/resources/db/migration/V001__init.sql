CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS measures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    policy_ref TEXT,
    owner TEXT,
    tags TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS measure_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    measure_id UUID NOT NULL REFERENCES measures(id),
    version TEXT NOT NULL,
    status TEXT NOT NULL,
    spec_json JSONB NOT NULL,
    cql_text TEXT,
    compile_status TEXT,
    compile_result JSONB,
    change_summary TEXT,
    approved_by TEXT,
    activated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (measure_id, version)
);

CREATE TABLE IF NOT EXISTS value_sets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    oid TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT,
    codes_json JSONB NOT NULL,
    last_resolved_at TIMESTAMPTZ,
    UNIQUE (oid, version)
);

CREATE TABLE IF NOT EXISTS measure_value_set_links (
    measure_version_id UUID NOT NULL REFERENCES measure_versions(id),
    value_set_id UUID NOT NULL REFERENCES value_sets(id),
    PRIMARY KEY (measure_version_id, value_set_id)
);

CREATE TABLE IF NOT EXISTS employees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    site TEXT,
    supervisor_id UUID REFERENCES employees(id),
    fhir_patient_id TEXT,
    start_date DATE,
    active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_type TEXT NOT NULL,
    scope_id UUID,
    site TEXT,
    trigger_type TEXT NOT NULL,
    status TEXT NOT NULL,
    triggered_by TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    total_evaluated INTEGER,
    compliant INTEGER,
    non_compliant INTEGER,
    duration_ms BIGINT,
    measurement_period_start TIMESTAMPTZ NOT NULL,
    measurement_period_end TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS run_logs (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES runs(id),
    ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    level TEXT NOT NULL,
    message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES runs(id),
    employee_id UUID NOT NULL REFERENCES employees(id),
    measure_version_id UUID NOT NULL REFERENCES measure_versions(id),
    evaluation_period TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence_json JSONB NOT NULL,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS outcomes_employee_measure_period_idx
    ON outcomes (employee_id, measure_version_id, evaluation_period);
CREATE INDEX IF NOT EXISTS outcomes_run_id_idx
    ON outcomes (run_id);

CREATE TABLE IF NOT EXISTS cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES employees(id),
    measure_version_id UUID NOT NULL REFERENCES measure_versions(id),
    evaluation_period TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    assignee TEXT,
    next_action TEXT,
    current_outcome_status TEXT NOT NULL,
    last_run_id UUID NOT NULL REFERENCES runs(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    UNIQUE (employee_id, measure_version_id, evaluation_period)
);

CREATE TABLE IF NOT EXISTS case_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    action_type TEXT NOT NULL,
    payload_json JSONB,
    performed_by TEXT,
    performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID,
    actor TEXT,
    ref_run_id UUID,
    ref_case_id UUID,
    ref_measure_version_id UUID,
    payload_json JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_events_ref_run_id_idx
    ON audit_events (ref_run_id);
CREATE INDEX IF NOT EXISTS audit_events_ref_case_id_idx
    ON audit_events (ref_case_id);
