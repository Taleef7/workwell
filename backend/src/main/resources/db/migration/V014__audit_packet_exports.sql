CREATE TABLE IF NOT EXISTS audit_packet_exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    packet_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    format TEXT NOT NULL,
    generated_by TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload_hash TEXT,
    payload_size_bytes BIGINT
);
