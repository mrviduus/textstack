-- Undoes 0009_bare_cfi_position: an epub-cfi reading position needs its quote again (the baseline's CHECKs).
-- Fails, on purpose, while a reading_state row holds a bare epub-cfi: ADD CONSTRAINT re-checks every row.
-- Nothing is deleted here: which positions may go is a human's call.

ALTER TABLE public.reading_state
    DROP CONSTRAINT ck_reading_state_current_locator_quote,
    ADD CONSTRAINT ck_reading_state_current_locator_quote
        CHECK (current_locator ->> 'scheme' <> 'epub-cfi' OR current_locator ? 'quote'),
    DROP CONSTRAINT ck_reading_state_frontier_locator_quote,
    ADD CONSTRAINT ck_reading_state_frontier_locator_quote
        CHECK (frontier_locator ->> 'scheme' <> 'epub-cfi' OR frontier_locator ? 'quote');
