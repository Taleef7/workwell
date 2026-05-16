-- V019__seed_case_assignees.sql
-- Distribute open cases across named case manager personas so the worklist looks
-- like a real lived-in system. Leaves ~40% unassigned (realistic queue state).
-- Idempotent: only updates rows where assignee IS NULL to avoid overwriting
-- any manually assigned cases from future runs.

DO $$
DECLARE
    v_open_count    INT;
    v_mitchell_n    INT;
    v_torres_n      INT;
BEGIN
    SELECT COUNT(*) INTO v_open_count FROM cases WHERE status = 'OPEN' AND assignee IS NULL;

    IF v_open_count = 0 THEN
        RETURN;
    END IF;

    v_mitchell_n := CEIL(v_open_count * 0.30)::INT;
    v_torres_n   := CEIL(v_open_count * 0.30)::INT;

    -- Assign ~30% to Sarah Mitchell (oldest open cases first)
    UPDATE cases
    SET assignee = 'Sarah Mitchell'
    WHERE id IN (
        SELECT id FROM cases
        WHERE status = 'OPEN' AND assignee IS NULL
        ORDER BY created_at ASC
        LIMIT v_mitchell_n
    );

    -- Assign ~30% to James Torres (next oldest open cases)
    UPDATE cases
    SET assignee = 'James Torres'
    WHERE id IN (
        SELECT id FROM cases
        WHERE status = 'OPEN' AND assignee IS NULL
        ORDER BY created_at ASC
        LIMIT v_torres_n
    );

    -- Remaining ~40% stay unassigned (realistic queue)
END $$;
