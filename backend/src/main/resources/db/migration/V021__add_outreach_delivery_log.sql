CREATE TABLE IF NOT EXISTS outreach_delivery_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    case_action_id UUID REFERENCES case_actions(id),
    to_address TEXT NOT NULL,
    subject TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL,
    error_detail TEXT
);

CREATE INDEX IF NOT EXISTS outreach_log_case_id_idx ON outreach_delivery_log(case_id);
CREATE INDEX IF NOT EXISTS outreach_log_sent_at_idx ON outreach_delivery_log(sent_at DESC);
