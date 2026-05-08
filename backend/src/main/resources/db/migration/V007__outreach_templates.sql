CREATE TABLE IF NOT EXISTS outreach_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_text TEXT NOT NULL,
    type TEXT NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO outreach_templates (id, name, subject, body_text, type, created_by, created_at, updated_at, active)
VALUES
    (
        '11111111-0000-0000-0000-000000000001',
        'Hearing Conservation Overdue Outreach',
        'Action Needed: Overdue Audiogram Follow-up',
        'Your annual audiogram is overdue. Please coordinate with occupational health for immediate scheduling.',
        'OUTREACH',
        'system',
        NOW(),
        NOW(),
        TRUE
    ),
    (
        '11111111-0000-0000-0000-000000000002',
        'TB Surveillance Follow-Up',
        'Upcoming TB Screening Due Date',
        'Your TB surveillance screening is due soon. Please book your screening within the compliance window.',
        'OUTREACH',
        'system',
        NOW(),
        NOW(),
        TRUE
    ),
    (
        '11111111-0000-0000-0000-000000000003',
        'General Compliance Reminder',
        'Compliance Follow-up Required',
        'Please review your pending occupational health requirement and complete the required follow-up as soon as possible.',
        'OUTREACH',
        'system',
        NOW(),
        NOW(),
        TRUE
    ),
    (
        '11111111-0000-0000-0000-000000000004',
        'Appointment Confirmation',
        'Appointment Scheduled: Occupational Health Follow-up',
        'Your appointment has been scheduled. Please arrive on time and bring any required documentation.',
        'APPOINTMENT_REMINDER',
        'system',
        NOW(),
        NOW(),
        TRUE
    )
ON CONFLICT (id) DO NOTHING;
