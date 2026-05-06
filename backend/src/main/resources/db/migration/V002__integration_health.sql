CREATE TABLE IF NOT EXISTS integration_health (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL,
    last_sync_at TIMESTAMPTZ,
    last_sync_result TEXT,
    config_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO integration_health (id, display_name, status, last_sync_result, config_json)
VALUES
    ('fhir', 'FHIR', 'unknown', 'No successful sync has been recorded yet.', '{}'::jsonb),
    ('mcp', 'MCP', 'unknown', 'No successful sync has been recorded yet.', '{}'::jsonb),
    ('ai', 'AI', 'unknown', 'No successful sync has been recorded yet.', '{}'::jsonb),
    ('hris', 'HRIS', 'unknown', 'No successful sync has been recorded yet.', '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
