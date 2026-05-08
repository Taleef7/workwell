INSERT INTO outreach_templates (id, name, subject, body_text, type, created_by, created_at, updated_at, active)
VALUES
    (
        '11111111-0000-0000-0000-000000000005',
        'Missing Data Follow-Up',
        'Action Needed: Missing Occupational Health Documentation',
        'We could not complete your occupational health review because documentation is missing. Please provide the required records or contact the clinic for assistance.',
        'OUTREACH',
        'system',
        NOW(),
        NOW(),
        TRUE
    )
ON CONFLICT (id) DO NOTHING;
