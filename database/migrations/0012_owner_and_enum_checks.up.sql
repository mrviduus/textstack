-- 0012_owner_and_enum_checks — enforce the owner and enum rules the code keeps by convention
--
-- What:  highlights, reading_sessions: CHECK at most one of edition_id / user_book_id is set
--          (num_nonnulls <= 1). None is allowed: deleting a book sets its key NULL and the row stays
--          the user's — highlights in All highlights and review, sessions in streaks and totals.
--        book_quality_jobs: CHECK exactly one is set (its FKs cascade, so none never happens).
--        book_collections: CHECK book_type IN ('userbook', 'savedbook').
--        seo_templates: one active template per (entity_type, field_type, language_code) — a unique
--          partial index, replacing the plain index on the same columns + is_active.
-- Why:   rules only the code kept; the database now refuses a row that breaks them.
-- Issue: https://github.com/mrviduus/textstack/issues/939
-- Compatibility: the previous release rejects a request with both owners (400), returns 409 for a
--        second active template, and deactivates before inserting on a template edit (#980).
--        Prod backup 2026-10-27: no row with both owners, no ownerless quality job, no other
--        book_type, no key with two active templates. A guard refuses, by name, any such row
--        written since. Locks: ACCESS EXCLUSIVE on the five tables, taken up front; past the 5 s
--        timeout the file aborts with nothing changed, and is rerun.
-- Down:  0012_owner_and_enum_checks.down.sql drops the CHECKs and the unique index and restores the
--        plain index, as 0000_baseline has it. No data changes either way.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.highlights, public.reading_sessions, public.book_quality_jobs,
    public.book_collections, public.seo_templates
    IN ACCESS EXCLUSIVE MODE;

-- Rows the constraints below would refuse: say which rule, instead of a bare 23514/23505.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.highlights WHERE num_nonnulls(edition_id, user_book_id) > 1)
        OR EXISTS (SELECT 1 FROM public.reading_sessions WHERE num_nonnulls(edition_id, user_book_id) > 1)
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

ALTER TABLE public.highlights
    ADD CONSTRAINT ck_highlights_owner CHECK (num_nonnulls(edition_id, user_book_id) <= 1);
ALTER TABLE public.reading_sessions
    ADD CONSTRAINT ck_reading_sessions_owner CHECK (num_nonnulls(edition_id, user_book_id) <= 1);
ALTER TABLE public.book_quality_jobs
    ADD CONSTRAINT ck_book_quality_jobs_owner CHECK (num_nonnulls(edition_id, user_book_id) = 1);
ALTER TABLE public.book_collections
    ADD CONSTRAINT ck_book_collections_book_type CHECK (book_type IN ('userbook', 'savedbook'));

DROP INDEX public.ix_seo_templates_entity_type_field_type_language_code_is_active;
CREATE UNIQUE INDEX ix_seo_templates_entity_type_field_type_language_code
    ON public.seo_templates USING btree (entity_type, field_type, language_code) WHERE is_active;
