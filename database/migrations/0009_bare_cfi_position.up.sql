-- 0009_bare_cfi_position — a reading position may be a bare epub-cfi (no quote, no context): mark-read's book start
--
-- What:  ck_reading_state_current_locator_quote and ck_reading_state_frontier_locator_quote also take an epub-cfi
--          locator holding only version, scheme and value. A CFI with a context but no quote is still refused.
-- Why:   ADR-033 P4: a chapter key needs the file's synced TOC, so "Mark as read" on a book never opened (no TOC,
--          no state) has no textstack-position-v1 to write. It writes the book's start as a bare CFI (a PDF:
--          pdf-page 1), which clients already resume by bookFraction (packages/shared statePosition).
--          SyncValidation.Locator takes the same shape.
-- Issue: https://github.com/mrviduus/textstack/issues/1524
-- Compatibility: both CHECKs only widen, so every stored row stays valid. Deploy the migration before the code:
--                until it is applied, V2Readiness sees it pending and every /me/v2 call answers 503.
-- Down:  0009_bare_cfi_position.down.sql restores the baseline's CHECKs. It fails while any reading_state row
--        holds a bare epub-cfi (the CHECK is re-validated on ADD); clear or re-send those positions first.

ALTER TABLE public.reading_state
    DROP CONSTRAINT ck_reading_state_current_locator_quote,
    ADD CONSTRAINT ck_reading_state_current_locator_quote
        CHECK (current_locator ->> 'scheme' <> 'epub-cfi' OR current_locator ? 'quote'
               OR current_locator - 'version' - 'scheme' - 'value' = '{}'::jsonb),
    DROP CONSTRAINT ck_reading_state_frontier_locator_quote,
    ADD CONSTRAINT ck_reading_state_frontier_locator_quote
        CHECK (frontier_locator ->> 'scheme' <> 'epub-cfi' OR frontier_locator ? 'quote'
               OR frontier_locator - 'version' - 'scheme' - 'value' = '{}'::jsonb);
