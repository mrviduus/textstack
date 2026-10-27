-- 0005_drop_notes — drop the dead standalone-notes table
--
-- What:  DROP TABLE notes (its 5 indexes and 5 FKs go with it).
-- Why:   no writer ever existed; a reader's notes live in highlights.note_text, book discussions in
--        book_insight. The previous release removed the Note entity and its call sites (#968).
-- Issue: https://github.com/mrviduus/textstack/issues/932
-- Compatibility: the deployed code no longer maps the table. Refuses to run if the table holds a
--        row, so nothing is dropped that someone wrote.
-- Down:  0005_drop_notes.down.sql recreates the table, indexes and FKs exactly as 0000_baseline has
--        them, empty. There were 0 rows; any data would come from the pre-deploy dump
--        (~/backups/textstack/pre-deploy-*) or a nightly backup.

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.notes) THEN
        RAISE EXCEPTION 'notes is not empty; refusing to drop it (#932)';
    END IF;
END $$;

DROP TABLE public.notes;
