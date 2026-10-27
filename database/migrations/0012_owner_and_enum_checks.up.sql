-- 0012_owner_and_enum_checks — enforce the one-owner and enum rules the code keeps by convention
--
-- What:  highlights, reading_sessions, book_quality_jobs: CHECK exactly one of edition_id /
--          user_book_id is set (num_nonnulls = 1).
--        highlights, reading_sessions: their edition_id and user_book_id FKs go from ON DELETE SET
--          NULL to CASCADE — SET NULL would leave a row with no owner, which the CHECK refuses, so
--          deleting a book would fail. Rows with no owner left by SET NULL so far are deleted first.
--        book_collections: CHECK book_type IN ('userbook', 'savedbook').
--        seo_templates: one active template per (entity_type, field_type, language_code) — a unique
--          partial index, replacing the plain index on the same columns + is_active.
-- Why:   rules only the code kept; the database now refuses a row that breaks them.
-- Issue: https://github.com/mrviduus/textstack/issues/939
-- Compatibility: the previous release rejects a request with both owners (400), returns 409 for a
--        second active template, and deactivates before inserting on a template edit (#980).
--        Prod backup 2026-10-27: 1 ownerless highlight and 14 ownerless reading sessions (deleted
--        here), no row with both owners, no other book_type, no key with two active templates. A
--        guard refuses, by name, any such row written since.
--        Locks: ACCESS EXCLUSIVE on the five tables, plus editions and user_books (the FK re-adds
--        lock them), all taken up front. Past the 5 s timeout the file aborts with nothing changed,
--        and is rerun.
-- Down:  0012_owner_and_enum_checks.down.sql drops the CHECKs and the unique index, restores the
--        plain index and the SET NULL FKs as 0000_baseline has them. The deleted ownerless rows are
--        not restored: they come from the pre-deploy dump (~/backups/textstack/pre-deploy-*) or a
--        nightly backup. Rows a CASCADE deleted after the up ran are gone the same way.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.highlights, public.reading_sessions, public.book_quality_jobs,
    public.book_collections, public.seo_templates, public.editions, public.user_books
    IN ACCESS EXCLUSIVE MODE;

-- Rows the constraints below would refuse, other than the ownerless ones deleted next: say which
-- rule, instead of a bare 23514/23505 from the ALTER.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.highlights WHERE num_nonnulls(edition_id, user_book_id) = 2)
        OR EXISTS (SELECT 1 FROM public.reading_sessions WHERE num_nonnulls(edition_id, user_book_id) = 2)
        OR EXISTS (SELECT 1 FROM public.book_quality_jobs WHERE num_nonnulls(edition_id, user_book_id) <> 1) THEN
        RAISE EXCEPTION 'a highlight, reading session or quality job has both owners (or a job none); fix it first (#939)';
    END IF;
    IF EXISTS (SELECT 1 FROM public.book_collections WHERE book_type NOT IN ('userbook', 'savedbook')) THEN
        RAISE EXCEPTION 'book_collections has a book_type other than userbook/savedbook; fix it first (#939)';
    END IF;
    IF EXISTS (SELECT 1 FROM public.seo_templates WHERE is_active
               GROUP BY entity_type, field_type, language_code HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'an SEO template key has two active rows; deactivate one first (#939)';
    END IF;
END $$;

-- Ownerless rows: the book they belonged to is gone (SET NULL); nothing reads them.
DELETE FROM public.highlights WHERE num_nonnulls(edition_id, user_book_id) = 0;
DELETE FROM public.reading_sessions WHERE num_nonnulls(edition_id, user_book_id) = 0;

ALTER TABLE public.highlights
    DROP CONSTRAINT fk_highlights_editions_edition_id,
    DROP CONSTRAINT fk_highlights_user_books_user_book_id,
    ADD CONSTRAINT fk_highlights_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE,
    ADD CONSTRAINT fk_highlights_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE CASCADE,
    ADD CONSTRAINT ck_highlights_owner CHECK (num_nonnulls(edition_id, user_book_id) = 1);

ALTER TABLE public.reading_sessions
    DROP CONSTRAINT fk_reading_sessions_editions_edition_id,
    DROP CONSTRAINT fk_reading_sessions_user_books_user_book_id,
    ADD CONSTRAINT fk_reading_sessions_editions_edition_id FOREIGN KEY (edition_id) REFERENCES public.editions(id) ON DELETE CASCADE,
    ADD CONSTRAINT fk_reading_sessions_user_books_user_book_id FOREIGN KEY (user_book_id) REFERENCES public.user_books(id) ON DELETE CASCADE,
    ADD CONSTRAINT ck_reading_sessions_owner CHECK (num_nonnulls(edition_id, user_book_id) = 1);

ALTER TABLE public.book_quality_jobs
    ADD CONSTRAINT ck_book_quality_jobs_owner CHECK (num_nonnulls(edition_id, user_book_id) = 1);

ALTER TABLE public.book_collections
    ADD CONSTRAINT ck_book_collections_book_type CHECK (book_type IN ('userbook', 'savedbook'));

DROP INDEX public.ix_seo_templates_entity_type_field_type_language_code_is_active;
CREATE UNIQUE INDEX ix_seo_templates_entity_type_field_type_language_code
    ON public.seo_templates USING btree (entity_type, field_type, language_code) WHERE is_active;
