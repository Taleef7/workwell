ALTER TABLE cases ADD COLUMN IF NOT EXISTS sla_due_date TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE cases
SET sla_due_date = created_at + CASE current_outcome_status
    WHEN 'OVERDUE'      THEN INTERVAL '14 days'
    WHEN 'MISSING_DATA' THEN INTERVAL '21 days'
    WHEN 'DUE_SOON'     THEN INTERVAL '30 days'
    ELSE                     INTERVAL '14 days'
END
WHERE sla_due_date IS NULL
    AND status IN ('OPEN', 'IN_PROGRESS');

CREATE INDEX IF NOT EXISTS cases_sla_due_date_idx
    ON cases(sla_due_date)
    WHERE status IN ('OPEN', 'IN_PROGRESS');